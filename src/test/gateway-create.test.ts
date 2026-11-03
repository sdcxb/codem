/**
 * B1：手机远程新建**会话/项目**（网关层契约）。
 *
 * 这一层只做三件事，判据也只钉这三件：
 * 1. **能力表如实**：注入了对应方法才报 supported；缺注入 ⇒ unsupported（手机据此不画按钮）。
 * 2. **形状校验**：name/path/title 的必填与上限在网关就拒（不把脏参数交给桌面写库）。
 * 3. **失败映射**：桌面的具名失败（INVALID_PARAMS/NOT_FOUND/CONFLICT/UNAVAILABLE）→
 *    对应 JSON-RPC 码与 `data.kind`；成功才返回 `{project}` / `{session}`。
 *
 * 真实写入（写的是桌面 `projects`/`sessions` 那一份库、沙箱校验、写后读回）
 * 在 `desktop-remote-create.test.ts`；手机面板行为在 `create-session-sheet.test.tsx`。
 */
import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_RPC_METHODS,
  GATEWAY_UNSUPPORTED_METHODS,
  gatewayRpcReply,
  gatewaySupportedMethods,
  type GatewayCreateOutcome,
  type GatewayDataDeps,
  type GatewayProjectSummary,
  type GatewaySessionSummary,
} from "../core/remote/gateway-engine";

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 9, method, params });
}

const PROJECT: GatewayProjectSummary = {
  id: "proj-1",
  name: "demo",
  path: "D:\\work\\demo",
  pinned: false,
  lastAccessedAt: 100,
};
const SESSION: GatewaySessionSummary = { id: "sess-1", title: "新会话", projectId: "proj-1" };

function baseDeps(overrides: Partial<GatewayDataDeps> = {}): GatewayDataDeps {
  return {
    listSessions: () => [],
    getSession: () => null,
    sendPrompt: async () => ({ ok: true, runId: "r", sessionId: "s" }),
    cancelRun: () => ({ ok: true, runId: "r", sessionId: "s", cancelled: true, state: "running" }),
    listApprovals: () => [],
    respondApproval: (input) => ({ ok: true, approvalId: input.approvalId, decision: input.decision, decidedBy: "phone" }),
    workspace: {
      list: async (path: string) => ({ path, entries: [] }),
      read: async (path: string) => ({ path, size: 0, truncated: false, text: "", encoding: "utf8" }),
      diff: async (path: string) => ({ path, diff: "", supported: true }),
      root: async () => null,
    },
    changes: {
      list: async () => ({ items: [], hasMore: false, supported: true }),
      diff: async (_s: string, _c: string, path: string) => ({ path, status: "M", patch: "", truncated: false, supported: true }),
    },
    listProjects: () => [PROJECT],
    createProject: async () => ({ ok: true, value: PROJECT }),
    createSession: async () => ({ ok: true, value: SESSION }),
    ...overrides,
  };
}

function failureOf(reply: Record<string, unknown>): { code: number; kind: string; message: string; hint?: string } {
  const error = reply.error as { code: number; message: string; data: { kind: string; hint?: string } };
  expect(error, "期望是一条 JSON-RPC 错误").toBeTruthy();
  return { code: error.code, kind: error.data.kind, message: error.message, hint: error.data.hint };
}

describe("B1-GW-1 能力表：注入了才报支持", () => {
  it("三个方法都在白名单里，且不再列进 unsupported；hello 逐字一致", async () => {
    for (const method of ["session.create", "project.list", "project.create"]) {
      expect(GATEWAY_RPC_METHODS).toContain(method);
      expect(GATEWAY_UNSUPPORTED_METHODS).not.toContain(method);
    }
    const hello = await gatewayRpcReply(rpc("host.hello", { protocolVersion: 1 }), baseDeps());
    const caps = (hello.result as any).capabilities;
    expect(caps.supported).toEqual([...GATEWAY_RPC_METHODS]);
    expect(caps.unsupported).toEqual([...GATEWAY_UNSUPPORTED_METHODS]);
  });

  it("缺注入 ⇒ 该方法不在 supported（不画点了必失败的按钮）", async () => {
    const deps = baseDeps({ listProjects: undefined, createProject: undefined, createSession: undefined });
    expect(gatewaySupportedMethods(deps)).not.toContain("project.list");
    expect(gatewaySupportedMethods(deps)).not.toContain("project.create");
    expect(gatewaySupportedMethods(deps)).not.toContain("session.create");
    const hello = await gatewayRpcReply(rpc("host.hello", { protocolVersion: 1 }), deps);
    const caps = (hello.result as any).capabilities;
    for (const method of ["project.list", "project.create", "session.create"]) {
      expect(caps.supported, `${method} 没有注入，不能报支持`).not.toContain(method);
      expect(caps.unsupported).toContain(method);
    }
    // 直接调用也必须如实 UNSUPPORTED（而不是抛异常/假装成功）
    for (const [method, params] of [
      ["project.list", {}],
      ["project.create", { name: "n", path: "D:\\p" }],
      ["session.create", {}],
    ] as const) {
      const reply = await gatewayRpcReply(rpc(method, params as any), deps);
      expect(failureOf(reply).kind, method).toBe("UNSUPPORTED");
    }
  });
});

describe("B1-GW-2 project.list", () => {
  it("返回桌面项目投影，limit 生效且 hasMore 如实", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...PROJECT, id: `p${i}`, name: `n${i}` }));
    const deps = baseDeps({ listProjects: () => many });
    const reply = await gatewayRpcReply(rpc("project.list", { limit: 2 }), deps);
    expect(reply.result).toEqual({ items: many.slice(0, 2), hasMore: true });
    const all = await gatewayRpcReply(rpc("project.list", {}), deps);
    expect((all.result as any).hasMore).toBe(false);
    expect((all.result as any).items).toHaveLength(5);
  });
});

describe("B1-GW-3 project.create 参数与失败映射", () => {
  it("name/path 原样交给桌面（trim 后），成功返回 {project}", async () => {
    const createProject = vi.fn(async () => ({ ok: true, value: PROJECT }) as GatewayCreateOutcome<GatewayProjectSummary>);
    const reply = await gatewayRpcReply(
      rpc("project.create", { name: "  demo  ", path: "  D:\\work\\demo  " }),
      baseDeps({ createProject }),
    );
    expect(reply.result).toEqual({ project: PROJECT });
    expect(createProject).toHaveBeenCalledWith({ name: "demo", path: "D:\\work\\demo" });
  });

  it("name 为空/超长、path 为空 ⇒ INVALID_PARAMS，且**不触碰**数据层", async () => {
    const createProject = vi.fn(async () => ({ ok: true, value: PROJECT }) as GatewayCreateOutcome<GatewayProjectSummary>);
    const deps = baseDeps({ createProject });
    for (const params of [
      { name: "", path: "D:\\p" },
      { name: "x".repeat(81), path: "D:\\p" },
      { name: "ok", path: "   " },
    ]) {
      const reply = await gatewayRpcReply(rpc("project.create", params), deps);
      expect(failureOf(reply).kind).toBe("INVALID_PARAMS");
    }
    expect(createProject).not.toHaveBeenCalled();
  });

  it("桌面具名失败 → 对应错误码/kind/hint 原样带回（手机能显示具体原因）", async () => {
    const cases: Array<[GatewayCreateOutcome<GatewayProjectSummary>, number, string]> = [
      [{ ok: false, code: "INVALID_PARAMS", message: "路径必须是绝对路径", hint: "用 D:\\x" }, -32602, "INVALID_PARAMS"],
      [{ ok: false, code: "NOT_FOUND", message: "目录不存在" }, -32003, "NOT_FOUND"],
      [{ ok: false, code: "CONFLICT", message: "已是项目" }, -32004, "CONFLICT"],
      [{ ok: false, code: "UNAVAILABLE", message: "存储未就绪" }, -32000, "UNAVAILABLE"],
    ];
    for (const [outcome, code, kind] of cases) {
      const reply = await gatewayRpcReply(
        rpc("project.create", { name: "n", path: "D:\\p" }),
        baseDeps({ createProject: async () => outcome }),
      );
      const failure = failureOf(reply);
      expect(failure.code).toBe(code);
      expect(failure.kind).toBe(kind);
      expect(failure.message).toContain((outcome as any).message);
    }
  });
});

describe("B1-GW-4 session.create", () => {
  it("projectId/title 透传；成功返回 {session}", async () => {
    const createSession = vi.fn(async () => ({ ok: true, value: SESSION }) as GatewayCreateOutcome<GatewaySessionSummary>);
    const reply = await gatewayRpcReply(
      rpc("session.create", { title: "  修 bug  ", projectId: "proj-1" }),
      baseDeps({ createSession }),
    );
    expect(reply.result).toEqual({ session: SESSION });
    expect(createSession).toHaveBeenCalledWith({ title: "修 bug", projectId: "proj-1" });
  });

  it("title 超长 ⇒ INVALID_PARAMS；不带 projectId ⇒ 只传 title（全局会话）", async () => {
    const createSession = vi.fn(async () => ({ ok: true, value: SESSION }) as GatewayCreateOutcome<GatewaySessionSummary>);
    const deps = baseDeps({ createSession });
    const tooLong = await gatewayRpcReply(rpc("session.create", { title: "x".repeat(201) }), deps);
    expect(failureOf(tooLong).kind).toBe("INVALID_PARAMS");
    expect(createSession).not.toHaveBeenCalled();

    await gatewayRpcReply(rpc("session.create", {}), deps);
    expect(createSession).toHaveBeenCalledWith({});
  });

  it("项目不存在 → NOT_FOUND（不隐式建项目）", async () => {
    const reply = await gatewayRpcReply(
      rpc("session.create", { projectId: "nope" }),
      baseDeps({
        createSession: async () => ({ ok: false, code: "NOT_FOUND", message: "项目不存在：nope" }),
      }),
    );
    const failure = failureOf(reply);
    expect(failure.kind).toBe("NOT_FOUND");
    expect(failure.message).toContain("nope");
  });
});
