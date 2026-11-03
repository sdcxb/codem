/**
 * 桌面网关文件面**服务层**判据（GW-FS1..GW-FS12，ADR-0005 M3）。
 *
 * 直接驱动 `createGatewayWorkspace`，依赖全部是假 invoke / 假 git：
 * - 根解析：桌面当前项目优先，缺省回落到默认工作区，两者都没有 ⇒ NOT_FOUND；
 * - 路径/大小/二进制/截断只由注入的 Rust 命令回答（这里验证传参和形状）；
 * - 敏感读取：Host 同一规则表 + 两阶段审批 + 一次性 grant（批准一次只覆盖一次）；
 * - diff：非 git 是 `supported:false`（不是错误）；敏感文件先审批；git 参数硬化；
 * - 未跟踪新文件合成 patch（不能把"未跟踪"画成"没有改动"）。
 */
import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GATEWAY_DIFF_MAX_CHARS,
  GATEWAY_LIST_MAX_ENTRIES,
  GatewayWorkspaceError,
  createGatewayWorkspace,
} from "../core/remote/gateway-workspace";

const execFileAsync = promisify(execFile);

type Deps = Parameters<typeof createGatewayWorkspace>[0];

interface FakeFile {
  rel: string;
  kind: "file" | "dir";
  text?: string;
  encoding?: "utf8" | "binary";
  size?: number;
}

function fakeDeps(over: Partial<Deps> = {}) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const files = new Map<string, FakeFile>();
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === "gateway_workspace_list") {
      return [
        { name: "src", type: "dir" },
        { name: "a.ts", type: "file", size: 3 },
      ];
    }
    if (cmd === "gateway_workspace_stat") {
      const entry = files.get(String(args.path));
      if (!entry) throw new Error("E_WORKSPACE_TARGET: 目标不存在");
      return { rel: entry.rel, size: entry.size ?? entry.text?.length ?? 0, kind: entry.kind };
    }
    if (cmd === "gateway_workspace_read") {
      const entry = files.get(String(args.path));
      if (!entry) throw new Error("E_WORKSPACE_TARGET: 目标不存在");
      if (args.expectRel !== entry.rel) throw new Error("E_WORKSPACE_TARGET: 目标已变化");
      const text = entry.text ?? "";
      return {
        path: entry.rel,
        rel: entry.rel,
        size: entry.size ?? text.length,
        truncated: false,
        text: entry.encoding === "binary" ? "" : text,
        encoding: entry.encoding ?? "utf8",
      };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const gitCalls: string[][] = [];
  const runGit = vi.fn(async (_cwd: string, args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
    if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
    if (args.includes("ls-files")) return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "--no-pager") return { stdout: "PATCH\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const deps: Deps = {
    invoke,
    runGit,
    currentProjectPath: () => "C:\\desktop-project",
    defaultWorkspacePath: async () => "C:\\fallback-workspace",
    ...over,
  };
  return { deps, calls, files, gitCalls, invoke, runGit };
}

function file(over: Partial<FakeFile> & { rel: string }): FakeFile {
  return { kind: "file", ...over };
}

async function expectWorkspaceError(
  p: Promise<unknown>,
  kind: string,
): Promise<GatewayWorkspaceError> {
  try {
    await p;
    throw new Error(`应当抛 ${kind}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayWorkspaceError);
    expect((e as GatewayWorkspaceError).kind).toBe(kind);
    return e as GatewayWorkspaceError;
  }
}

describe("GW-FS1 根解析：桌面当前项目 → 默认工作区 → NOT_FOUND", () => {
  it("当前项目优先；没有项目时用默认工作区；两者都没有报 NOT_FOUND", async () => {
    const first = fakeDeps();
    const svc = createGatewayWorkspace(first.deps);
    await svc.list("");
    expect(first.calls[0].args.workspace).toBe("C:\\desktop-project");

    const fallback = fakeDeps({ currentProjectPath: () => null });
    await createGatewayWorkspace(fallback.deps).list("");
    expect(fallback.calls[0].args.workspace).toBe("C:\\fallback-workspace");

    const none = fakeDeps({
      currentProjectPath: () => null,
      defaultWorkspacePath: async () => "",
    });
    await expectWorkspaceError(createGatewayWorkspace(none.deps).list(""), "NOT_FOUND");
    expect(none.calls).toHaveLength(0);
  });
});

describe("GW-FS2 list：一层目录，上限 500，相对路径", () => {
  it("把 root/path 交给 Rust，条目原样投影", async () => {
    const f = fakeDeps();
    const got = await createGatewayWorkspace(f.deps).list("src");
    expect(f.calls[0]).toEqual({
      cmd: "gateway_workspace_list",
      args: { workspace: "C:\\desktop-project", path: "src" },
    });
    expect(got).toEqual({
      path: "src",
      entries: [
        { name: "src", type: "dir" },
        { name: "a.ts", type: "file", size: 3 },
      ],
    });
  });

  it("超过 500 条截断（协议没有 truncated 字段；这是已知限制）", async () => {
    const many = Array.from({ length: GATEWAY_LIST_MAX_ENTRIES + 20 }, (_, i) => ({
      name: `f${i}.txt`,
      type: "file",
      size: 1,
    }));
    const f = fakeDeps({
      invoke: vi.fn(async () => many),
    } as never);
    const got = await createGatewayWorkspace(f.deps).list("");
    expect(got.entries).toHaveLength(GATEWAY_LIST_MAX_ENTRIES);
  });

  it("路径越界 → INVALID_PARAMS（不把 Rust 原始错误透出）", async () => {
    const f = fakeDeps({
      invoke: vi.fn(async () => {
        throw "E_WORKSPACE_PATH: 路径不在工作区内";
      }),
    } as never);
    const err = await expectWorkspaceError(createGatewayWorkspace(f.deps).list("secret"), "INVALID_PARAMS");
    expect(err.message).toContain("工作区");
    expect(err.message).not.toContain("C:\\");
  });

  it("Rust 返回的形状不对 ⇒ INTERNAL（不伪装成空目录）", async () => {
    const f = fakeDeps({
      invoke: vi.fn(async () => ({ not: "an array" })),
    } as never);
    const err = await expectWorkspaceError(createGatewayWorkspace(f.deps).list(""), "INTERNAL");
    expect(err.message).toContain("目录列表");
  });
});

describe("GW-FS3 read：普通文件零审批，参数按协议", () => {
  it("先 stat 拿真实 rel，再带着 expectRel 读", async () => {
    const f = fakeDeps();
    f.files.set("src/a.ts", file({ rel: "src/a.ts", text: "abc", size: 3 }));
    const got = await createGatewayWorkspace(f.deps).read("src/a.ts", 1, 2);
    expect(got).toMatchObject({ path: "src/a.ts", text: "abc", encoding: "utf8" });
    expect(f.calls.map((c) => c.cmd)).toEqual(["gateway_workspace_stat", "gateway_workspace_read"]);
    expect(f.calls[1].args).toEqual({
      workspace: "C:\\desktop-project",
      path: "src/a.ts",
      expectRel: "src/a.ts",
      offset: 1,
      limit: 2,
    });
  });

  it("二进制原样透传 encoding=binary（不把字节塞进 JSON）", async () => {
    const f = fakeDeps();
    f.files.set("blob.bin", file({ rel: "blob.bin", encoding: "binary", size: 4 }));
    const got = await createGatewayWorkspace(f.deps).read("blob.bin", 0, 200_000);
    expect(got).toMatchObject({ encoding: "binary", text: "" });
  });

  it("别名指向敏感目标时，expectRel 用的是真实目标（TOCTOU 收口）", async () => {
    const f = fakeDeps();
    f.files.set("notes.txt", file({ rel: ".env", text: "SECRET=1" }));
    const err = await expectWorkspaceError(
      createGatewayWorkspace(f.deps).read("notes.txt", 0, 100),
      "APPROVAL_REQUIRED",
    );
    expect((err.details as any).details.path).toBe(".env");
  });
});

describe("GW-FS4 敏感读取：拒绝目录 vs 两阶段审批", () => {
  it("应用内部产物直接拒绝（不弹审批、不读文件）", async () => {
    const f = fakeDeps();
    f.files.set(".codem-snapshots/x.json", file({ rel: ".codem-snapshots/x.json", text: "{}" }));
    const err = await expectWorkspaceError(
      createGatewayWorkspace(f.deps).read(".codem-snapshots/x.json", 0, 100),
      "INVALID_PARAMS",
    );
    expect(err.message).toContain("应用内部产物");
    expect(f.calls.map((c) => c.cmd)).toEqual(["gateway_workspace_stat"]);
  });

  it(".env：首次只回审批详情；批准后带同一个 id 重试才读；且只能用一次", async () => {
    const f = fakeDeps();
    f.files.set(".env", file({ rel: ".env", text: "SECRET=1" }));
    const svc = createGatewayWorkspace(f.deps);
    const err = await expectWorkspaceError(svc.read(".env", 0, 100), "APPROVAL_REQUIRED");
    const details = err.details as any;
    expect(details.approvalRequired).toBe(true);
    expect(details.tool).toBe("workspace.read");
    expect(details.details.scope).toBe("shared-desktop-workspace");
    expect(details.details.notice).toContain("这台手机");
    expect(f.calls.some((c) => c.cmd === "gateway_workspace_read"), "首次不能读到正文").toBe(false);
    expect(svc.listPendingApprovals()).toEqual([
      expect.objectContaining({
        requestId: details.approvalId,
        sessionId: "",
        tool: "workspace.read",
        status: "open",
      }),
    ]);

    expect(svc.respondApproval(details.approvalId, "allow")).toEqual({ handled: true, ok: true });
    const got = await svc.read(".env", 0, 100, details.approvalId);
    expect(got.text).toBe("SECRET=1");

    // 一次性：同一个 approvalId 再用必须重新审批
    const again = await expectWorkspaceError(svc.read(".env", 0, 100, details.approvalId), "APPROVAL_REQUIRED");
    expect((again.details as any).approvalId).not.toBe(details.approvalId);
  });

  it("拒绝不产生 grant；同样的读取仍然要审批", async () => {
    const f = fakeDeps();
    f.files.set(".env", file({ rel: ".env", text: "SECRET=1" }));
    const svc = createGatewayWorkspace(f.deps);
    const err = await expectWorkspaceError(svc.read(".env", 0, 100), "APPROVAL_REQUIRED");
    const approvalId = (err.details as any).approvalId;
    expect(svc.respondApproval(approvalId, "deny")).toEqual({ handled: true, ok: true });
    await expectWorkspaceError(svc.read(".env", 0, 100, approvalId), "APPROVAL_REQUIRED");
  });

  it("审批过期：答复如实失败，且不能再用", async () => {
    let now = 1_000;
    const f = fakeDeps({ now: () => now });
    f.files.set(".env", file({ rel: ".env", text: "SECRET=1" }));
    const svc = createGatewayWorkspace(f.deps);
    const err = await expectWorkspaceError(svc.read(".env", 0, 100), "APPROVAL_REQUIRED");
    const approvalId = (err.details as any).approvalId;
    now += 6 * 60_000;
    expect(svc.respondApproval(approvalId, "allow")).toEqual({
      handled: true,
      ok: false,
      message: expect.stringContaining("过期"),
    });
    await expectWorkspaceError(svc.read(".env", 0, 100, approvalId), "APPROVAL_REQUIRED");
  });

  it("不是网关的审批 id：明确交回桌面代理（handled:false）", () => {
    const f = fakeDeps();
    const svc = createGatewayWorkspace(f.deps);
    expect(svc.respondApproval("perm-desktop-1", "allow")).toEqual({ handled: false });
  });
});

describe("GW-FS5 diff：非 git 是结果，敏感文件先审批，git 参数硬化", () => {
  it("非 git 仓库 ⇒ supported:false（不是错误）", async () => {
    const f = fakeDeps();
    f.files.set("src/a.ts", file({ rel: "src/a.ts", text: "a" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "false\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const got = await createGatewayWorkspace(f.deps).diff("src/a.ts", "HEAD");
    expect(got).toEqual({ path: "src/a.ts", diff: "", supported: false });
  });

  it("git 超时（124）不是「不是 git 仓库」，而是可行动的 CONFLICT", async () => {
    const f = fakeDeps();
    f.files.set("src/a.ts", file({ rel: "src/a.ts", text: "a" }));
    f.runGit.mockImplementation(async () => ({ stdout: "", stderr: "", exitCode: 124 }));
    await expectWorkspaceError(createGatewayWorkspace(f.deps).diff("src/a.ts", "HEAD"), "CONFLICT");
  });

  it("符号链接别名指向 .env：按真实目标审批，git 也按真实路径跑", async () => {
    const f = fakeDeps();
    f.files.set("notes.txt", file({ rel: ".env", text: "SECRET=1" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: ".env\u0000", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A\n+B\n", stderr: "", exitCode: 0 };
    });
    const svc = createGatewayWorkspace(f.deps);
    const err = await expectWorkspaceError(svc.diff("notes.txt", "HEAD"), "APPROVAL_REQUIRED");
    expect((err.details as any).details.path).toBe(".env");
    expect((err.details as any).details.files).toEqual([".env"]);

    expect(svc.respondApproval((err.details as any).approvalId, "allow")).toEqual({
      handled: true,
      ok: true,
    });
    const got = await svc.diff("notes.txt", "HEAD", (err.details as any).approvalId);
    expect(got.path).toBe(".env");
    const finalCall = f.runGit.mock.calls
      .map((call) => call[1] as string[])
      .find((args) => args.includes("--no-color"));
    expect(finalCall?.at(-1)).toBe(".env");
  });

  it(".env 被改动：先审批（files 清单），批准后最终 diff 带硬化参数", async () => {    const f = fakeDeps();
    f.files.set(".env", file({ rel: ".env", text: "SECRET=1" }));
    let phase: "pre" | "diff" = "pre";
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) {
        return { stdout: phase === "pre" ? ".env\u0000src/a.ts\u0000" : ".env\u0000", stderr: "", exitCode: 0 };
      }
      if (args.includes("ls-files")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "--no-pager") {
        phase = "diff";
        return { stdout: "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A\n+B\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const svc = createGatewayWorkspace(f.deps);

    const err = await expectWorkspaceError(svc.diff(".env", "HEAD"), "APPROVAL_REQUIRED");
    const details = err.details as any;
    expect(details.tool).toBe("workspace.diff");
    expect(details.details.files).toEqual([".env"]);
    expect(details.details.base).toBe("HEAD");
    expect(details.details.notice).toContain("这台手机");

    expect(svc.respondApproval(details.approvalId, "allow")).toEqual({ handled: true, ok: true });
    phase = "pre"; // 重试时重新预检
    const got = await svc.diff(".env", "HEAD", details.approvalId);
    expect(got.supported).toBe(true);
    expect(got.diff).toContain("+B");
    // mockImplementation 会替换 fakeDeps 里记录 gitCalls 的实现 ⇒ 从 vi 的调用记录里取。
    const finalCall = f.runGit.mock.calls
      .map((call) => call[1] as string[])
      .find((args) => args.includes("--no-color"));
    expect(finalCall).toBeTruthy();
    expect(finalCall).toContain("--no-ext-diff");
    expect(finalCall).toContain("--no-textconv");
    expect(finalCall).toContain("HEAD");
  });

  it("应用内部产物的差异直接拒绝（不弹审批）", async () => {
    const f = fakeDeps();
    f.files.set("src/a.ts", file({ rel: "src/a.ts", text: "a" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) {
        return { stdout: ".codem-snapshots/x.json\u0000", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const err = await expectWorkspaceError(
      createGatewayWorkspace(f.deps).diff("src/a.ts", "HEAD"),
      "INVALID_PARAMS",
    );
    expect(err.message).toContain("应用内部产物");
  });

  it("非法 base 在跑 git 之前拒绝（不许以 - 开头）", async () => {
    const f = fakeDeps();
    for (const base of ["--output=x", "a b", ""] ) {
      if (base === "") continue; // 空串 = 缺省 HEAD
      const err = await expectWorkspaceError(
        createGatewayWorkspace(f.deps).diff("src/a.ts", base),
        "INVALID_PARAMS",
      );
      expect(err.message).toContain("base");
    }
    expect(f.runGit).not.toHaveBeenCalled();
  });

  it("超过 200,000 字符截断并给 reason（不假装完整）", async () => {
    const f = fakeDeps();
    f.files.set("src/a.ts", file({ rel: "src/a.ts", text: "a" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "+".repeat(GATEWAY_DIFF_MAX_CHARS + 100), stderr: "", exitCode: 0 };
    });
    const got = await createGatewayWorkspace(f.deps).diff("src/a.ts", "HEAD");
    expect(got.supported).toBe(true);
    expect(got.diff).toHaveLength(GATEWAY_DIFF_MAX_CHARS);
    expect(got.reason).toContain("200,000");
  });
});

describe("GW-FS6 未跟踪新文件：合成 patch，不画成「没有改动」", () => {
  it("文本新文件生成只有新增行的 patch", async () => {
    const f = fakeDeps();
    f.files.set("new.ts", file({ rel: "new.ts", text: "hello\nworld\n" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: "new.ts\u0000", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const got = await createGatewayWorkspace(f.deps).diff("new.ts", "HEAD");
    expect(got.supported).toBe(true);
    expect(got.diff).toContain("new file mode 100644");
    expect(got.diff).toContain("@@ -0,0 +1,2 @@");
    expect(got.diff).toContain("+hello");
    expect(got.diff).toContain("+world");
  });

  it("二进制新文件如实 supported:false + reason", async () => {
    const f = fakeDeps();
    f.files.set("logo.bin", file({ rel: "logo.bin", encoding: "binary", size: 10 }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: "logo.bin\u0000", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const got = await createGatewayWorkspace(f.deps).diff("logo.bin", "HEAD");
    expect(got.supported).toBe(false);
    expect(got.reason).toContain("二进制");
  });

  it("未跟踪的敏感新文件同样要先审批", async () => {
    const f = fakeDeps();
    f.files.set(".env.local", file({ rel: ".env.local", text: "SECRET=1" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: ".env.local\u0000", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const err = await expectWorkspaceError(
      createGatewayWorkspace(f.deps).diff(".env.local", "HEAD"),
      "APPROVAL_REQUIRED",
    );
    expect((err.details as any).details.files).toEqual([".env.local"]);
  });

  it("被 gitignore 的 .env 也要审批，并合成新文件 patch（不能画成「没有改动」）", async () => {
    const f = fakeDeps();
    f.files.set(".env", file({ rel: ".env", text: "SECRET=1\n" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      // --others --exclude-standard 不列被忽略的文件
      if (args.includes("ls-files") && args.includes("--others")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // ls-files --error-unmatch 失败 ⇒ 不是已跟踪文件
      if (args.includes("ls-files")) return { stdout: "", stderr: "error", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const svc = createGatewayWorkspace(f.deps);
    const err = await expectWorkspaceError(svc.diff(".env", "HEAD"), "APPROVAL_REQUIRED");
    const details = err.details as any;
    expect(details.details.files).toEqual([".env"]);
    expect(svc.respondApproval(details.approvalId, "allow")).toEqual({ handled: true, ok: true });
    const got = await svc.diff(".env", "HEAD", details.approvalId);
    expect(got.supported).toBe(true);
    expect(got.diff).toContain("new file mode 100644");
    expect(got.diff).toContain("+SECRET=1");
  });

  it("已跟踪但没改：diff 为空是正确事实（不合成新文件 patch）", async () => {
    const f = fakeDeps();
    f.files.set("src/a.ts", file({ rel: "src/a.ts", text: "a" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files") && args.includes("--others")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args.includes("ls-files")) return { stdout: "src/a.ts\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const got = await createGatewayWorkspace(f.deps).diff("src/a.ts", "HEAD");
    expect(got.supported).toBe(true);
    expect(got.diff).toBe("");
  });

  it("已跟踪且干净的敏感文件：空 diff 不必审批（没有内容可读）", async () => {
    const f = fakeDeps();
    f.files.set(".env", file({ rel: ".env", text: "SECRET=1" }));
    f.runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files") && args.includes("--others")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args.includes("ls-files")) return { stdout: ".env\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const got = await createGatewayWorkspace(f.deps).diff(".env", "HEAD");
    expect(got.supported).toBe(true);
    expect(got.diff).toBe("");
  });
});

describe("GW-FS7 真实 git：参数硬化不会把正常 diff 挡掉", () => {
  async function git(cwd: string, args: string[]) {
    try {
      const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
        maxBuffer: 4_000_000,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number | string };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  }

  async function repoWith(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "codem-gw-git-"));
    await git(root, ["init", "-q"]);
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(root, name), text, "utf8");
    }
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.email=gateway-test@example.invalid",
      "-c",
      "user.name=Gateway Test",
      "commit",
      "-qm",
      "init",
    ]);
    return root;
  }

  it("tracked 修改返回真实 patch；bracket 文件名按字面匹配", async () => {
    const root = await repoWith({ "a[1].txt": "bracket-old\n", "a1.txt": "plain-old\n" });
    try {
      await writeFile(join(root, "a[1].txt"), "bracket-new\n", "utf8");
      await writeFile(join(root, "a1.txt"), "plain-new\n", "utf8");
      const f = fakeDeps({
        currentProjectPath: () => root,
        invoke: vi.fn(async () => ({ rel: "a[1].txt", size: 12, kind: "file" })),
        runGit: (cwd, args) => git(cwd, args),
      } as never);
      const got = await createGatewayWorkspace(f.deps).diff("a[1].txt", "HEAD");
      expect(got.supported).toBe(true);
      expect(got.diff).toContain("-bracket-old");
      expect(got.diff).toContain("+bracket-new");
      // 若 pathspec 被当成通配符，a1.txt 也会进来（显示成第二个文件段）。
      expect(got.diff).not.toContain("plain-old");
      expect(got.diff).not.toContain("plain-new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
