/**
 * 网关变更面判据（GWC-1..GWC-7，ADR-0005 M3）。
 *
 * 守的是"变更记录只从桌面那一份数据来，且共享 UI 的「变更」页签真的有后端"：
 * 1. 能力表包含两条方法，unsupported 不再包含它们；
 * 2. 参数原样交给注入的桌面数据层（offset/limit 有界，path 不 trim）；
 * 3. 非法参数 → INVALID_PARAMS，且**不触碰数据层**；
 * 4. 未知会话/记录 → NOT_FOUND；内部异常 → INTERNAL 且不回显原始路径；
 * 5. `supported:false` 是结果不是错误（reason 原样下发）；
 * 6. 生产接线只有一处：`desktop-engine` 注入 `createChangesService` + 桌面
 *    `FileChangeStorage` / `queryChangesPage` / `cwdForSession` / `runGitCommand` / 敏感规则；
 * 7. Rust 白名单、TS 能力表、共享 UI 的能力位三者一致。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GATEWAY_RPC_METHODS,
  GATEWAY_UNSUPPORTED_METHODS,
  gatewayRpcReply,
  type GatewayChangesApi,
  type GatewayDataDeps,
} from "../core/remote/gateway-engine";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const SESSION = { id: "sess-changes-1", title: "桌面会话", projectId: "p1", projectName: "demo" };

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 21, method, params });
}

interface Harness {
  deps: GatewayDataDeps;
  changes: {
    list: ReturnType<typeof vi.fn>;
    diff: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<GatewayChangesApi> = {}): Harness {
  const changes = {
    list: vi.fn(async () => ({ items: [], hasMore: false, supported: true })),
    diff: vi.fn(async (_sessionId: string, _changeId: string, path: string) => ({
      path,
      status: "M",
      patch: "diff",
      truncated: false,
      supported: true,
    })),
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
    workspace: {
      list: async (path: string) => ({ path, entries: [] }),
      read: async (path: string) => ({ path, size: 0, truncated: false, text: "", encoding: "utf8" }),
      diff: async (path: string) => ({ path, diff: "", supported: true }),
      root: async () => "C:\\desktop-project",
    },
    changes,
  };
  return { deps, changes };
}

function failureOf(reply: Record<string, unknown>): {
  code: number;
  kind: string;
  message: string;
  retryable: boolean;
} {
  const error = reply.error as {
    code: number;
    message: string;
    data: { kind: string; retryable: boolean };
  };
  expect(error, "期望是一条 JSON-RPC 错误").toBeTruthy();
  return {
    code: error.code,
    kind: error.data.kind,
    message: error.message,
    retryable: error.data.retryable,
  };
}

function hostError(kind: string, message: string, hint?: string): Error {
  return Object.assign(new Error(message), { kind, ...(hint ? { hint } : {}) });
}

describe("GWC-1 能力表与两条方法", () => {
  it("supported 含两条；unsupported 不再含它们", async () => {
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
    for (const method of ["session.changes", "session.change.diff"]) {
      expect(GATEWAY_UNSUPPORTED_METHODS).not.toContain(method);
    }
    expect(GATEWAY_UNSUPPORTED_METHODS).toContain("attachment.put");

    const hello = await gatewayRpcReply(rpc("host.hello", { protocolVersion: 1 }), harness().deps);
    const caps = (hello.result as any).capabilities;
    expect(caps.supported).toEqual([...GATEWAY_RPC_METHODS]);
    expect(caps.supported.filter((m: string) => caps.unsupported.includes(m))).toEqual([]);
  });
});

describe("GWC-2 session.changes 参数与形状", () => {
  it("缺省 offset=0/limit=20；参数原样交给数据层", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(rpc("session.changes", { sessionId: SESSION.id }), h.deps);
    expect(reply.result).toEqual({ items: [], hasMore: false, supported: true });
    expect(h.changes.list).toHaveBeenCalledWith(SESSION.id, 0, 20);
  });

  it("offset/limit 有界（offset>=0，limit 1..50）", async () => {
    const h = harness();
    await gatewayRpcReply(
      rpc("session.changes", { sessionId: SESSION.id, offset: -9, limit: 999 }),
      h.deps,
    );
    expect(h.changes.list).toHaveBeenCalledWith(SESSION.id, 0, 50);
  });

  it("缺 sessionId → INVALID_PARAMS，且不触碰数据层", async () => {
    const h = harness();
    for (const params of [{}, { sessionId: 7 }, { sessionId: "  " }]) {
      const reply = await gatewayRpcReply(rpc("session.changes", params), h.deps);
      expect(failureOf(reply).kind, JSON.stringify(params)).toBe("INVALID_PARAMS");
    }
    expect(h.changes.list).not.toHaveBeenCalled();
  });
});

describe("GWC-3 session.change.diff 参数", () => {
  it("三个参数都原样交给数据层；path 不 trim", async () => {
    const h = harness();
    await gatewayRpcReply(
      rpc("session.change.diff", {
        sessionId: SESSION.id,
        changeId: "tfc-1",
        path: " dir/a b.txt ",
      }),
      h.deps,
    );
    expect(h.changes.diff).toHaveBeenCalledWith(SESSION.id, "tfc-1", " dir/a b.txt ");
  });

  it("缺 changeId / path 或类型不对 → INVALID_PARAMS，不触碰数据层", async () => {
    const h = harness();
    for (const params of [
      { sessionId: SESSION.id, path: "a.ts" },
      { sessionId: SESSION.id, changeId: "tfc-1" },
      { sessionId: SESSION.id, changeId: "tfc-1", path: 3 },
      { sessionId: SESSION.id, changeId: "tfc-1", path: "" },
    ]) {
      const reply = await gatewayRpcReply(rpc("session.change.diff", params), h.deps);
      expect(failureOf(reply).kind, JSON.stringify(params)).toBe("INVALID_PARAMS");
    }
    expect(h.changes.diff).not.toHaveBeenCalled();
  });
});

describe("GWC-4 错误码可行动，不把失败画成空数据", () => {
  it("NOT_FOUND / INVALID_PARAMS / INTERNAL 各自映射；INTERNAL 不回显原始异常", async () => {
    const cases: Array<[Error, number, string]> = [
      [hostError("NOT_FOUND", "会话不存在：ghost"), -32003, "NOT_FOUND"],
      [hostError("INVALID_PARAMS", "path 必须是工作区内的相对路径", "只看记录清单"), -32602, "INVALID_PARAMS"],
      [hostError("CONFLICT", "读取 git 对象超时"), -32004, "CONFLICT"],
      [new Error("raw C:\\secret\\path"), -32603, "INTERNAL"],
    ];
    for (const [error, code, kind] of cases) {
      const h = harness({
        list: vi.fn(async () => {
          throw error;
        }),
      });
      const reply = await gatewayRpcReply(rpc("session.changes", { sessionId: SESSION.id }), h.deps);
      const failure = failureOf(reply);
      expect(failure.kind).toBe(kind);
      expect(failure.code).toBe(code);
      if (kind === "INTERNAL") {
        expect(failure.message).toBe("读取桌面变更记录失败");
        expect(JSON.stringify(reply)).not.toContain("secret");
      }
      if (kind === "CONFLICT") expect(failure.retryable).toBe(true);
    }
  });

  it("supported:false 是结果（reason 原样下发），不是错误", async () => {
    const h = harness({
      list: vi.fn(async () => ({
        items: [],
        hasMore: false,
        supported: false,
        reason: "当前工作区不是 git 仓库",
      })),
    });
    const reply = await gatewayRpcReply(rpc("session.changes", { sessionId: SESSION.id }), h.deps);
    expect(reply.error).toBeUndefined();
    expect((reply.result as any).supported).toBe(false);
    expect((reply.result as any).reason).toContain("不是 git 仓库");
  });
});

describe("GWC-5 生产接线只有一处，数据来自桌面那一份", () => {
  it("desktop-engine 注入 createChangesService + 桌面存储/工作区/git/敏感规则", () => {
    const desktop = read("src/core/remote/desktop-engine.ts");
    expect(desktop).toContain("createChangesService({");
    expect(desktop).toContain("queryChangesPage(sid, offset, limit)");
    expect(desktop).toContain("FileChangeStorage.getByIdAsync(id)");
    expect(desktop).toContain("cwdForSession(sid)");
    // 可见性必须与 session.list/session.get 同一份投影（内部项目不因猜中 id 而暴露）
    expect(desktop).toContain("flattenSessions().some((s) => s.id === id)");
    expect(desktop).toContain("FileChangeTracker.isGitWorkspace(workspace)");
    expect(desktop).toContain("runGitCommand(workspace, args");
    expect(desktop).toContain("isSensitiveReadPath");
    expect(desktop).toContain("changes: gatewayChanges");
    // 没有第二份存储/记录：不 import 第二个变更表，也不写文件
    expect(desktop).not.toContain("turn_file_changes\"");
    expect(desktop).not.toContain("FileChangeStorage.create");
  });

  it("gateway-engine 的两个分支交给注入的数据层，不自己读库", () => {
    const engine = read("src/core/remote/gateway-engine.ts");
    expect(engine).toContain('case "session.changes"');
    expect(engine).toContain('case "session.change.diff"');
    expect(engine).toContain("deps.changes.list(");
    expect(engine).toContain("deps.changes.diff(");
    for (const banned of ['from "../storage', "FileChangeStorage", "queryChangesPage"]) {
      expect(engine, `网关渲染层不得直接读库：${banned}`).not.toContain(banned);
    }
  });

  it("Rust 白名单、TS 能力表、共享 UI 能力位一致", () => {
    const mod = read("src-tauri/src/phone/gateway/mod.rs");
    const whitelist =
      /const RPC_ALLOWED_METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(mod)?.[1] ?? "";
    for (const method of ["session.changes", "session.change.diff"]) {
      expect(whitelist, `Rust 白名单必须包含 ${method}`).toContain(`"${method}"`);
    }
    const app = read("packages/ui/src/mobile-app.tsx");
    expect(app).toContain("sessionId && caps.changes ? (");
    const transport = read("packages/ui/src/transport.ts");
    expect(transport).toContain('has("session.changes") && has("session.change.diff")');
    expect(transport).toContain('client.rpc<SessionChangesResult>("session.changes"');
    expect(transport).toContain('client.rpc<SessionChangeDiffResult>("session.change.diff"');
  });
});
