/**
 * RPC 敏感读取的两阶段审批（SRPC-1..8）。
 *
 * 这些判据直接驱动 `sensitive-access.ts`（runtime 的方法只是薄接线）：
 * - 首次读取敏感文件 ⇒ `APPROVAL_REQUIRED` 且**没有正文**；
 * - 批准 + 同一个 approvalId 重试 ⇒ 正文；再重试 ⇒ 重新要审批（一次性）；
 * - 拒绝 ⇒ 永远不返回正文；
 * - 普通文件 / 非共享工作区 ⇒ 零审批；
 * - 路径逃逸在审批之前就被拒（不能拿审批探测路径存在性）；
 * - diff 的敏感文件清单来自只读预检；grant 过期后必须重新审批。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { HostError } from "../../packages/host/src/errors";
import { resolveHostConfig } from "../../packages/host/src/config";
import { HostRuntime } from "../../packages/host/src/runtime";
import {
  ApprovalGrantStore,
  SENSITIVE_APPROVAL_TTL_MS,
  diffWorkspaceFileGuarded,
  readWorkspaceFileGuarded,
  type GitDiffRunner,
  type SensitiveApprovalRegistration,
} from "../../packages/host/src/sensitive-access";
import type { SensitiveApprovalRequiredDetails } from "../../packages/protocol/src/index";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codem-srpc-"));
  dirs.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".env"), "SECRET_TOKEN=not-for-model\n", "utf8");
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  return root;
}

async function gitRepo(): Promise<string> {
  const root = await tempWorkspace();
  await execFileAsync("git", ["-C", root, "init"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "host-test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Host Test"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
  // `.env` 是 tracked 文件：改动后才会出现在 diff 里
  await writeFile(join(root, ".env"), "SECRET_TOKEN=changed\n", "utf8");
  await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  return root;
}

function gitRunner(root: string): GitDiffRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 4_000_000 });
      return { code: 0, out: stdout, err: stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
      return { code: typeof err.code === "number" ? err.code : 1, out: err.stdout ?? "", err: err.stderr ?? String(err.message ?? e) };
    }
  };
}

interface Harness {
  registrations: SensitiveApprovalRegistration[];
  register: (r: SensitiveApprovalRegistration) => void;
  grants: ApprovalGrantStore;
}

function harness(now: () => number = Date.now): Harness {
  const registrations: SensitiveApprovalRegistration[] = [];
  return {
    registrations,
    register: (r) => registrations.push(r),
    grants: new ApprovalGrantStore(now),
  };
}

async function expectApprovalRequired(fn: () => Promise<unknown>): Promise<SensitiveApprovalRequiredDetails> {
  try {
    await fn();
  } catch (e) {
    expect(e, "必须是 HostError").toBeInstanceOf(HostError);
    const err = e as HostError;
    expect(err.kind).toBe("APPROVAL_REQUIRED");
    const details = err.details as SensitiveApprovalRequiredDetails;
    expect(details.approvalRequired).toBe(true);
    expect(details.approvalId).toMatch(/^appr-/);
    expect(details.details.scope).toBe("shared-desktop-workspace");
    expect(details.details.notice).toContain("发送给模型");
    return details;
  }
  throw new Error("应当抛 APPROVAL_REQUIRED，但调用成功了");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("SRPC-1/2 读取敏感文件：先审批，批准后一次性放行", () => {
  it("首次 APPROVAL_REQUIRED 不带正文；批准后带 approvalId 才返回正文；再重试又要审批", async () => {
    const root = await tempWorkspace();
    const h = harness();
    const read = (approvalId?: string) =>
      readWorkspaceFileGuarded({ root, path: ".env", shared: true, grants: h.grants, register: h.register, ...(approvalId ? { approvalId } : {}) });

    const details = await expectApprovalRequired(() => read());
    expect(h.registrations).toHaveLength(1);
    const registration = h.registrations[0];
    expect(registration.view.tool).toBe("workspace.read");
    expect(registration.view.summary).toContain(".env");
    expect(registration.view.summary).toContain("发送给模型");
    expect(registration.grant).toMatchObject({ tool: "workspace.read", key: ".env", files: [".env"] });
    expect(details.details.path).toBe(".env");
    expect(details.details.rule).toBe("env");

    h.grants.grant(details.approvalId, registration.grant);
    const ok = await read(details.approvalId);
    expect(ok.text).toContain("SECRET_TOKEN");

    // 一次性：同一个 approvalId 第二次使用必须重新审批
    await expectApprovalRequired(() => read(details.approvalId));
    expect(h.registrations).toHaveLength(2);
  });

  it("拒绝（不登记 grant）⇒ 重试仍要审批，且永不返回正文", async () => {
    const root = await tempWorkspace();
    const h = harness();
    const details = await expectApprovalRequired(() =>
      readWorkspaceFileGuarded({ root, path: ".env", shared: true, grants: h.grants, register: h.register }),
    );
    // 模拟 approval.respond deny：只删审批，不发 grant
    h.grants.delete(details.approvalId);
    const again = await expectApprovalRequired(() =>
      readWorkspaceFileGuarded({
        root,
        path: ".env",
        shared: true,
        grants: h.grants,
        register: h.register,
        approvalId: details.approvalId,
      }),
    );
    expect(again.details.path).toBe(".env");
  });
});

describe("SRPC-4/5 普通路径与非共享工作区零审批", () => {
  it("src/a.ts 不登记审批", async () => {
    const root = await tempWorkspace();
    const h = harness();
    const got = await readWorkspaceFileGuarded({ root, path: "src/a.ts", shared: true, grants: h.grants, register: h.register });
    expect(got.text).toContain("export const a = 1");
    expect(h.registrations).toHaveLength(0);
  });

  it("shared=false：读 .env 不登记审批（Android 本机行为不变）", async () => {
    const root = await tempWorkspace();
    const h = harness();
    const got = await readWorkspaceFileGuarded({ root, path: ".env", shared: false, grants: h.grants, register: h.register });
    expect(got.text).toContain("SECRET_TOKEN");
    expect(h.registrations).toHaveLength(0);
  });
});

describe("SRPC-6 路径逃逸在审批之前被拒绝", () => {
  it("读 ../outside.txt ⇒ INVALID_PARAMS，且不产生审批", async () => {
    const root = await tempWorkspace();
    const h = harness();
    await expect(
      readWorkspaceFileGuarded({ root, path: "../outside.txt", shared: true, grants: h.grants, register: h.register }),
    ).rejects.toMatchObject({ kind: "INVALID_PARAMS" });
    expect(h.registrations).toHaveLength(0);
  });

  it(".codem-snapshots 直接拒绝且不产生审批", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, ".codem-snapshots"), { recursive: true });
    await writeFile(join(root, ".codem-snapshots", "snap-1.json"), "{}", "utf8");
    const h = harness();
    await expect(
      readWorkspaceFileGuarded({
        root,
        path: ".codem-snapshots/snap-1.json",
        shared: true,
        grants: h.grants,
        register: h.register,
      }),
    ).rejects.toMatchObject({ kind: "INVALID_PARAMS" });
    expect(h.registrations).toHaveLength(0);
  });
});

describe("SRPC-7 diff：敏感文件清单来自只读预检", () => {
  it("diff('.env') 要审批；diff('src/a.ts') 不要；diff('.') 列出 .env", async () => {
    const root = await gitRepo();
    const h = harness();
    const run = gitRunner(root);
    const diff = (path: string, approvalId?: string) =>
      diffWorkspaceFileGuarded({
        root,
        path,
        base: "HEAD",
        shared: true,
        grants: h.grants,
        register: h.register,
        run,
        ...(approvalId ? { approvalId } : {}),
      });

    const sensitive = await expectApprovalRequired(() => diff(".env"));
    expect(sensitive.tool).toBe("workspace.diff");
    expect(sensitive.details.files).toEqual([".env"]);
    expect(sensitive.details.base).toBe("HEAD");
    expect(h.registrations).toHaveLength(1);

    // 普通文件：不审批、直接返回 patch
    const normal = await diff("src/a.ts");
    expect(normal.supported).toBe(true);
    expect(normal.diff).toContain("export const a = 2");
    expect(h.registrations, "普通文件不应新增审批").toHaveLength(1);

    // path="." 时敏感清单里仍然列出 .env
    const whole = await expectApprovalRequired(() => diff("."));
    expect(whole.details.files).toContain(".env");
    expect(whole.details.fileCount).toBe(1);

    // 批准后返回原 diff
    const registration = h.registrations[h.registrations.length - 1];
    h.grants.grant(whole.approvalId, registration.grant);
    const approved = await diff(".", whole.approvalId);
    expect(approved.supported).toBe(true);
    expect(approved.diff).toContain("SECRET_TOKEN=changed");
  });

  it("非 git 工作区：supported=false（不审批、不假装有 diff）", async () => {
    const root = await tempWorkspace();
    const h = harness();
    const got = await diffWorkspaceFileGuarded({
      root,
      path: "src/a.ts",
      shared: true,
      grants: h.grants,
      register: h.register,
      run: gitRunner(root),
    });
    expect(got.supported).toBe(false);
    expect(h.registrations).toHaveLength(0);
  });
});

describe("SRPC-9 runtime 接线：approval.list → respondApproval → 一次性 grant", () => {
  /**
   * 不启动数据库（`HostRuntime.create` 会拉起 codem-db）：只调构造函数拿字段初值，
   * 然后直接驱动 `readWorkspaceFile` / `listApprovals` / `respondApproval` 三个方法。
   * 这三条是 RPC 两阶段的全部粘合点，必须被真实方法覆盖（而不是只测纯函数）。
   */
  function headlessRuntime(root: string): HostRuntime {
    const config = resolveHostConfig({
      overrides: {
        dataHome: join(root, ".host-data"),
        dbPath: join(root, ".host-data", "db.bin"),
        dbBin: process.execPath,
        workspaceRoot: root,
        workspaceSharedWithDesktop: true,
        port: 0,
      },
    });
    const Ctor = HostRuntime as unknown as new (c: unknown, d: unknown) => HostRuntime;
    return new Ctor(config, { llm: null });
  }

  it("首次 APPROVAL_REQUIRED ⇒ approval.list 可见 ⇒ allow ⇒ 带 id 读到正文 ⇒ 第二次又要审批", async () => {
    const root = await tempWorkspace();
    const runtime = headlessRuntime(root);

    const details = await expectApprovalRequired(() => runtime.readWorkspaceFile(".env"));
    const pending = runtime.listApprovals();
    expect(pending.map((p) => p.approvalId)).toContain(details.approvalId);
    expect(pending.find((p) => p.approvalId === details.approvalId)?.sessionId).toBe("");

    await runtime.respondApproval(details.approvalId, "allow", "req-allow");
    const got = await runtime.readWorkspaceFile(".env", 0, 200_000, details.approvalId);
    expect(got.text).toContain("SECRET_TOKEN");

    // 一次性：同一个 id 再来一次必须重新审批
    await expectApprovalRequired(() => runtime.readWorkspaceFile(".env", 0, 200_000, details.approvalId));
  });

  it("deny ⇒ 不发 grant；重试仍 APPROVAL_REQUIRED 且没有正文", async () => {
    const root = await tempWorkspace();
    const runtime = headlessRuntime(root);
    const details = await expectApprovalRequired(() => runtime.readWorkspaceFile(".env"));
    await runtime.respondApproval(details.approvalId, "deny", "req-deny");
    await expectApprovalRequired(() => runtime.readWorkspaceFile(".env", 0, 200_000, details.approvalId));
  });

  it("非共享工作区：runtime 直接读，不产生审批", async () => {
    const root = await tempWorkspace();
    const config = resolveHostConfig({
      overrides: {
        dataHome: join(root, ".host-data"),
        dbPath: join(root, ".host-data", "db.bin"),
        dbBin: process.execPath,
        workspaceRoot: root,
        workspaceSharedWithDesktop: false,
        port: 0,
      },
    });
    const Ctor = HostRuntime as unknown as new (c: unknown, d: unknown) => HostRuntime;
    const runtime = new Ctor(config, { llm: null });
    const got = await runtime.readWorkspaceFile(".env");
    expect(got.text).toContain("SECRET_TOKEN");
    expect(runtime.listApprovals()).toEqual([]);
  });
});

describe("SRPC-8 grant TTL 过期 ⇒ 重新审批", () => {
  it("过期后带旧 approvalId 重试仍要审批", async () => {
    let now = 1_000_000;
    const root = await tempWorkspace();
    const h = harness(() => now);
    const details = await expectApprovalRequired(() =>
      readWorkspaceFileGuarded({ root, path: ".env", shared: true, grants: h.grants, register: h.register }),
    );
    h.grants.grant(details.approvalId, h.registrations[0].grant, SENSITIVE_APPROVAL_TTL_MS);
    now += SENSITIVE_APPROVAL_TTL_MS + 1;
    await expectApprovalRequired(() =>
      readWorkspaceFileGuarded({
        root,
        path: ".env",
        shared: true,
        grants: h.grants,
        register: h.register,
        approvalId: details.approvalId,
      }),
    );
  });

  it("grant 只对精确路径有效（换路径不复用）", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, ".env.local"), "OTHER=1\n", "utf8");
    const h = harness();
    const first = await expectApprovalRequired(() =>
      readWorkspaceFileGuarded({ root, path: ".env", shared: true, grants: h.grants, register: h.register }),
    );
    h.grants.grant(first.approvalId, h.registrations[0].grant);
    await expectApprovalRequired(() =>
      readWorkspaceFileGuarded({
        root,
        path: ".env.local",
        shared: true,
        grants: h.grants,
        register: h.register,
        approvalId: first.approvalId,
      }),
    );
  });
});
