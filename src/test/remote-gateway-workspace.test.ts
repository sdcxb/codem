/**
 * 网关文件面判据（GW-F1..GW-F9，ADR-0005 M3）。
 *
 * 守的是"文件面只在网关白名单里，形状与错误码可行动，且没有第二套数据/边界"：
 * 1. `workspace.list/read/diff` 出现在能力表，`session.changes`/写/终端仍不在；
 * 2. 参数原样交给注入的桌面数据层；非法类型/空路径 → `INVALID_PARAMS`，不触碰数据层；
 * 3. `APPROVAL_REQUIRED` 必须是 `error.data.details` 再套一层（共享 UI 据此渲染审批卡）；
 * 4. 越界/不存在/冲突各自映射到可行动的错误码；
 * 5. `host.diagnostics` 报出当前数据根（手机知道文件页签看的是哪个目录）；
 * 6. 生产接线只有一处：`desktop-engine` 注入 `createGatewayWorkspace`，Rust 注册
 *    `gateway_workspace_*` 三个命令；边界模块不 import Node fs。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GATEWAY_RPC_METHODS,
  GATEWAY_UNSUPPORTED_METHODS,
  gatewayRpcReply,
  type GatewayDataDeps,
  type GatewayWorkspaceApi,
} from "../core/remote/gateway-engine";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const SESSION = { id: "sess-file-1", title: "桌面会话", projectId: "p1", projectName: "demo" };

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 11, method, params });
}

interface Harness {
  deps: GatewayDataDeps;
  workspace: {
    list: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    diff: ReturnType<typeof vi.fn>;
    root: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<GatewayWorkspaceApi> = {}): Harness {
  const workspace = {
    list: vi.fn(async (path: string) => ({ path, entries: [{ name: "a.ts", type: "file" as const, size: 3 }] })),
    read: vi.fn(async (path: string) => ({ path, size: 3, truncated: false, text: "abc", encoding: "utf8" as const })),
    diff: vi.fn(async (path: string, base: string) => ({ path, diff: `diff ${base}`, supported: true })),
    root: vi.fn(async () => "C:\\desktop-project"),
    ...overrides,
  };
  const deps: GatewayDataDeps = {
    listSessions: () => [SESSION],
    getSession: () => ({ session: SESSION, messages: [] }),
    sendPrompt: async () => ({ ok: true, runId: "run-1", sessionId: SESSION.id }),
    cancelRun: (input) => ({
      ok: true,
      runId: input.runId,
      sessionId: SESSION.id,
      cancelled: true,
      state: "running",
    }),
    listApprovals: () => [],
    respondApproval: (input) => ({
      ok: true,
      approvalId: input.approvalId,
      decision: input.decision,
      decidedBy: "phone",
    }),
    workspace,
    changes: {
      list: async () => ({ items: [], hasMore: false, supported: true }),
      diff: async (_sessionId: string, _changeId: string, path: string) => ({
        path,
        status: "M",
        patch: "",
        truncated: false,
        supported: true,
      }),
    },
  };
  return { deps, workspace };
}

function failureOf(reply: Record<string, unknown>): {
  code: number;
  kind: string;
  message: string;
  retryable: boolean;
  data: Record<string, unknown>;
} {
  const error = reply.error as {
    code: number;
    message: string;
    data: Record<string, unknown> & { kind: string; retryable: boolean };
  };
  expect(error, "期望是一条 JSON-RPC 错误").toBeTruthy();
  return {
    code: error.code,
    kind: error.data.kind,
    message: error.message,
    retryable: error.data.retryable,
    data: error.data,
  };
}

function workspaceError(
  kind: string,
  message: string,
  extra: { details?: unknown; hint?: string } = {},
): Error {
  return Object.assign(new Error(message), { kind, ...extra });
}

describe("GW-F1 能力表含只读文件面 + 变更面", () => {
  it("supported 含 workspace.* 与 session.changes*；终端/附件仍不在", async () => {
    expect([...GATEWAY_RPC_METHODS]).toEqual([
      "host.hello",
      "host.diagnostics",
      "session.list",
      "session.get",
      "prompt.send",
      "run.cancel",
      "approval.list",
      "approval.respond",
      "workspace.list",
      "workspace.read",
      "workspace.diff",
      "session.changes",
      "session.change.diff",
    ]);
    for (const banned of ["terminal.open", "workspace.write", "attachment.put"]) {
      expect(GATEWAY_RPC_METHODS).not.toContain(banned);
    }
    expect(GATEWAY_UNSUPPORTED_METHODS).not.toContain("workspace.read");
    expect(GATEWAY_UNSUPPORTED_METHODS).not.toContain("session.changes");

    const hello = await gatewayRpcReply(rpc("host.hello", { protocolVersion: 1 }), harness().deps);
    const caps = (hello.result as any).capabilities;
    expect(caps.supported).toEqual([...GATEWAY_RPC_METHODS]);
    expect(caps.supported.filter((m: string) => caps.unsupported.includes(m))).toEqual([]);
    for (const method of ["workspace.list", "workspace.read", "workspace.diff"]) {
      expect(caps.supported).toContain(method);
      expect(caps.unsupported).not.toContain(method);
    }
  });

  it("host.diagnostics 报出当前数据根（只诊断，不放进 hello）", async () => {
    const diag = await gatewayRpcReply(rpc("host.diagnostics"), harness().deps);
    expect((diag.result as any).workspaceRoot).toBe("C:\\desktop-project");
    expect((diag.result as any).readOnly).toBe(false);

    const none = harness({ root: vi.fn(async () => null) });
    const noRoot = await gatewayRpcReply(rpc("host.diagnostics"), none.deps);
    expect((noRoot.result as any).workspaceRoot).toBeNull();
  });
});

describe("GW-F2 workspace.list 参数与形状", () => {
  it("缺省 path = '.'；路径原样交给数据层", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(rpc("workspace.list"), h.deps);
    expect((reply.result as any).entries).toHaveLength(1);
    expect(h.workspace.list).toHaveBeenCalledWith(".");

    const nested = harness();
    await gatewayRpcReply(rpc("workspace.list", { path: "src/组件" }), nested.deps);
    expect(nested.workspace.list).toHaveBeenCalledWith("src/组件");
  });

  it("非法 path 类型 → INVALID_PARAMS，且不触碰数据层", async () => {
    const h = harness();
    for (const params of [{ path: 123 }, { path: null }]) {
      const reply = await gatewayRpcReply(rpc("workspace.list", params), h.deps);
      expect(failureOf(reply).kind).toBe("INVALID_PARAMS");
      expect(failureOf(reply).code).toBe(-32602);
    }
    expect(h.workspace.list).not.toHaveBeenCalled();
  });
});

describe("GW-F3 workspace.read 参数、默认值与审批详情", () => {
  it("offset/limit 有界；approvalId 只在有值时出现", async () => {
    const h = harness();
    await gatewayRpcReply(rpc("workspace.read", { path: "src/a.ts" }), h.deps);
    expect(h.workspace.read).toHaveBeenCalledWith("src/a.ts", 0, 200_000, undefined);

    const withApproval = harness();
    await gatewayRpcReply(
      rpc("workspace.read", { path: ".env", offset: 2, limit: 5, approvalId: "appr-1" }),
      withApproval.deps,
    );
    expect(withApproval.workspace.read).toHaveBeenCalledWith(".env", 2, 5, "appr-1");

    const clamped = harness();
    await gatewayRpcReply(
      rpc("workspace.read", { path: "a", offset: -4, limit: 99_999_999 }),
      clamped.deps,
    );
    expect(clamped.workspace.read).toHaveBeenCalledWith("a", 0, 2_000_000, undefined);

    const bad = harness();
    const reply = await gatewayRpcReply(rpc("workspace.read", { path: "a", approvalId: 7 }), bad.deps);
    expect(failureOf(reply).kind).toBe("INVALID_PARAMS");
    expect(bad.workspace.read).not.toHaveBeenCalled();
  });

  it("APPROVAL_REQUIRED 的 details 必须嵌在 error.data.details 里", async () => {
    const details = {
      approvalRequired: true,
      approvalId: "appr-ws-1",
      tool: "workspace.read",
      summary: "读取敏感文件 .env（环境变量文件）",
      details: {
        path: ".env",
        rule: "env",
        label: "环境变量文件",
        reason: "可能包含 API Key",
        risk: "high",
        scope: "shared-desktop-workspace",
        notice: "批准后内容会发送到这台手机",
      },
      expiresAt: 1_800_000_000_000,
    };
    const h = harness({
      read: vi.fn(async () => {
        throw workspaceError("APPROVAL_REQUIRED", "读取敏感文件 .env", {
          details,
          hint: "批准后带同一个 approvalId 重试",
        });
      }),
    });
    const reply = await gatewayRpcReply(rpc("workspace.read", { path: ".env" }), h.deps);
    const failure = failureOf(reply);
    expect(failure.kind).toBe("APPROVAL_REQUIRED");
    expect(failure.code).toBe(-32008);
    expect(failure.retryable).toBe(false);
    // 共享 UI 读的是 data.details；再平铺一层就会让审批卡拿不到 approvalId。
    expect(failure.data.details).toEqual(details);
    expect((failure.data.details as any).approvalId).toBe("appr-ws-1");
  });
});

describe("GW-F4 文件面错误码可行动，不把失败画成空数据", () => {
  it("越界 → INVALID_PARAMS；不存在 → NOT_FOUND；git 冲突 → CONFLICT（可重试）", async () => {
    const cases: Array<[unknown, number, string]> = [
      [workspaceError("INVALID_PARAMS", "路径不在工作区内"), -32602, "INVALID_PARAMS"],
      [workspaceError("NOT_FOUND", "文件或目录不存在"), -32003, "NOT_FOUND"],
      [workspaceError("CONFLICT", "无法运行 git"), -32004, "CONFLICT"],
    ];
    for (const [error, code, kind] of cases) {
      const h = harness({
        read: vi.fn(async () => {
          throw error;
        }),
      });
      const reply = await gatewayRpcReply(rpc("workspace.read", { path: "a" }), h.deps);
      const failure = failureOf(reply);
      expect(failure.kind).toBe(kind);
      expect(failure.code).toBe(code);
      if (kind === "CONFLICT") expect(failure.retryable).toBe(true);
      else expect(failure.retryable).toBe(false);
    }
  });

  it("未知异常 → INTERNAL，且 message 来自数据层而不是把原始异常直接透出", async () => {
    const h = harness({
      list: vi.fn(async () => {
        throw new Error("raw C:\\secret\\path");
      }),
    });
    const reply = await gatewayRpcReply(rpc("workspace.list", {}), h.deps);
    const failure = failureOf(reply);
    expect(failure.kind).toBe("INTERNAL");
    expect(failure.message).toBe("读取桌面工作区失败");
    expect(JSON.stringify(reply)).not.toContain("secret");
  });
});

describe("GW-F5 workspace.diff 的基线与非 git 语义", () => {
  it("缺省 base = HEAD；带 approvalId；supported=false 是结果不是错误", async () => {
    const h = harness();
    const notGit = harness({
      diff: vi.fn(async (path: string) => ({ path, diff: "", supported: false, reason: "不是 git 仓库" })),
    });
    const reply = await gatewayRpcReply(rpc("workspace.diff", { path: "" }), notGit.deps);
    expect(reply.result).toEqual({ path: "", diff: "", supported: false, reason: "不是 git 仓库" });
    expect(notGit.workspace.diff).toHaveBeenCalledWith("", "HEAD", undefined);

    const approved = harness();
    await gatewayRpcReply(
      rpc("workspace.diff", { path: "src/a.ts", base: "HEAD~1", approvalId: "appr-2" }),
      approved.deps,
    );
    expect(approved.workspace.diff).toHaveBeenCalledWith("src/a.ts", "HEAD~1", "appr-2");
    expect(h.workspace.diff).not.toHaveBeenCalled();
  });

  it("base 类型不对 → INVALID_PARAMS；path 缺失 → INVALID_PARAMS", async () => {
    const h = harness();
    for (const params of [{}, { path: 1, base: "HEAD" }, { path: "a", base: 2 }]) {
      const reply = await gatewayRpcReply(rpc("workspace.diff", params), h.deps);
      expect(failureOf(reply).kind).toBe("INVALID_PARAMS");
    }
    expect(h.workspace.diff).not.toHaveBeenCalled();
  });
});

describe("GW-F6 生产接线只有一处，边界不落到 Node", () => {
  it("desktop-engine 注入 createGatewayWorkspace / runGitCommand / 审批合并", () => {
    const desktop = read("src/core/remote/desktop-engine.ts");
    expect(desktop).toContain("createGatewayWorkspace({");
    expect(desktop).toContain("runGitCommand(cwd, args");
    expect(desktop).toContain("workspace: {");
    expect(desktop).toContain("list: gatewayWorkspace.list");
    expect(desktop).toContain("gatewayWorkspace.listPendingApprovals()");
    expect(desktop).toContain("gatewayWorkspace.respondApproval(");

    const service = read("src/core/remote/gateway-workspace.ts");
    // 敏感规则/grant 复用 Host 的唯一实现，不复制规则表。
    expect(service).toContain("packages/host/src/sensitive-paths");
    expect(service).toContain("packages/host/src/sensitive-approvals");
    expect(service).not.toContain("node:fs");
    expect(service).not.toContain("node:path");
    expect(service).not.toContain("readFile");
  });

  it("Rust 侧注册了三个只读命令，白名单与 TS 一一对应", () => {
    const lib = read("src-tauri/src/lib.rs");
    for (const cmd of [
      "phone::gateway::workspace::gateway_workspace_list",
      "phone::gateway::workspace::gateway_workspace_stat",
      "phone::gateway::workspace::gateway_workspace_read",
    ]) {
      expect(lib).toContain(cmd);
    }
    const mod = read("src-tauri/src/phone/gateway/mod.rs");
    const whitelist =
      /const RPC_ALLOWED_METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(mod)?.[1] ?? "";
    for (const method of GATEWAY_RPC_METHODS) {
      expect(whitelist, `Rust 白名单必须包含 ${method}`).toContain(`"${method}"`);
    }
    for (const banned of ["terminal.open", "attachment.put"]) {
      expect(whitelist).not.toContain(`"${banned}"`);
    }
  });
});
