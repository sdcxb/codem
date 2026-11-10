/**
 * PC 桌面远程网关 **M2 写路径第一批** 的协议判据（GW-W1..GW-W9）。
 *
 * 守的是"`prompt.send` / `run.cancel` 在网关这一层真的通了，而且没有半套"：
 * 1. `prompt.send` 返回 `runId`，参数（含 requestId/clientId）原样交给桌面执行层；
 * 2. 参数不合法 → `INVALID_PARAMS`，**不触碰**执行层；
 * 3. 未实现的附件 → 如实 `UNSUPPORTED`（不吞掉、不假装上传成功）；
 * 4. 忙/他人占用/并发上限 → 各自独立的错误码与 kind（手机据此给出不同文案）；
 * 5. `requestId` 幂等标记透传（重发不产生第二次执行由 `gateway-runs` 保证）；
 * 6. `run.cancel` 的成功/已结束/找不到/别人家的 四种应答都如实现；
 * 7. capabilities 只多这两个方法 —— 审批/事件**不得**混进 supported；
 * 8. `host.diagnostics` 不再自称只读。
 *
 * 真实执行（`executeSessionTurn` / run 归属 / 中止）在 `desktop-engine` 与
 * `gateway-runs`，分别由 `remote-gateway-write-wiring.test.ts` 与
 * `gateway-run-registry.test.ts` 钉住。
 */
import { describe, it, expect } from "vitest";

import {
  GATEWAY_RPC_METHODS,
  GATEWAY_UNSUPPORTED_METHODS,
  gatewayRpcReply,
  type GatewayCancelRunInput,
  type GatewayCancelRunResult,
  type GatewayDataDeps,
  type GatewaySendPromptInput,
  type GatewaySendPromptResult,
} from "../core/remote/gateway-engine";

const SESSION = { id: "sess-write-1", title: "桌面会话", projectId: "p1", projectName: "demo" };

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 7, method, params });
}

interface Harness {
  deps: GatewayDataDeps;
  sent: GatewaySendPromptInput[];
  cancelled: GatewayCancelRunInput[];
}

function harness(overrides: Partial<GatewayDataDeps> = {}): Harness {
  const sent: GatewaySendPromptInput[] = [];
  const cancelled: GatewayCancelRunInput[] = [];
  const deps: GatewayDataDeps = {
    listSessions: () => [SESSION],
    sync: {
      pull: async () => ({
        events: [],
        nextSeq: 0,
        hasMore: false,
        devices: 0,
        scannedSessions: 0,
        missingBodies: 0,
        droppedEntries: 0,
        droppedUnpulled: 0,
        resetRequired: false,
        oldestSeq: 0,
        filteredSessions: 0,
        overCapacity: false,
        serverTime: 0,
      }),
      push: async () => ({
        accepted: 0,
        duplicates: 0,
        rejected: [],
        hostSeqMax: 0,
        devices: 0,
        storageFailed: 0,
        filteredSessions: 0,
      }),
      snapshot: async () => ({
        sessionId: "",
        messages: [],
        nextBefore: null,
        hasMore: false,
        total: 0,
        hostSeq: 0,
        filteredSessions: 0,
        serverTime: 0,
      }),
      mergeMemory: async () => ({ ok: true, payload: "", entries: 0, conflicts: [], changed: false }),
    },
    getSession: () => ({ session: SESSION, messages: [] }),
    sendPrompt: async (input) => {
      sent.push(input);
      return { ok: true, runId: "run-1", sessionId: input.sessionId };
    },
    cancelRun: (input) => {
      cancelled.push(input);
      return { ok: true, runId: input.runId, sessionId: SESSION.id, cancelled: true, state: "running" };
    },
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
      root: async () => null,
    },
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
    // B1：项目/会话创建（网关只做形状与错误码，真实写入在 desktop-engine）
    listProjects: () => [],
    createProject: async (input) => ({
      ok: true,
      value: { id: "proj-test", name: input.name, path: input.path, pinned: false, lastAccessedAt: 1 },
    }),
    createSession: async (input) => ({
      ok: true,
      value: { id: "sess-created", title: input.title ?? "新会话", projectId: input.projectId ?? "" },
    }),
    ...overrides,
  };
  return { deps, sent, cancelled };
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

describe("网关写路径第一批（M2）", () => {
  it("GW-W1: prompt.send 返回 runId，参数原样交给桌面执行层", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(
      rpc("prompt.send", {
        sessionId: SESSION.id,
        text: "  帮我改一下这个文件  ",
        requestId: "chat-1-1",
        clientId: "client-a",
        attachmentIds: [],
      }),
      h.deps,
    );

    expect(reply.result).toEqual({ runId: "run-1", sessionId: SESSION.id });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      sessionId: SESSION.id,
      text: "帮我改一下这个文件",
      requestId: "chat-1-1",
      clientId: "client-a",
    });
  });

  it("GW-W2: 缺 sessionId / 空 text / 非法 attachmentIds 都是 INVALID_PARAMS，且不碰执行层", async () => {
    const h = harness();
    for (const params of [
      { text: "hi" },
      { sessionId: "   ", text: "hi" },
      { sessionId: SESSION.id },
      { sessionId: SESSION.id, text: "   " },
      { sessionId: SESSION.id, text: "hi", attachmentIds: "a1" },
    ]) {
      const reply = await gatewayRpcReply(rpc("prompt.send", params), h.deps);
      const failure = failureOf(reply);
      expect(failure.kind, JSON.stringify(params)).toBe("INVALID_PARAMS");
      expect(failure.code).toBe(-32602);
    }
    expect(h.sent, "参数不合法时不该启动任何回合").toHaveLength(0);
  });

  it("GW-W3: 附件未实现 → UNSUPPORTED，不收下 id 也不启动回合", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(
      rpc("prompt.send", { sessionId: SESSION.id, text: "hi", attachmentIds: ["att-1"] }),
      h.deps,
    );
    const failure = failureOf(reply);
    expect(failure.kind).toBe("UNSUPPORTED");
    expect(failure.code).toBe(-32006);
    expect(failure.message).toContain("附件");
    expect(h.sent).toHaveLength(0);
  });

  it("GW-W4: 忙 / 他人占用 / 并发上限 各有独立错误码，且是可重试的", async () => {
    const cases: Array<[GatewaySendPromptResult & { ok: false }, number, string]> = [
      [{ ok: false, kind: "BUSY", message: "该会话正在处理中" }, -32011, "BUSY"],
      [{ ok: false, kind: "RUN_OWNED", message: "另一台设备在跑" }, -32012, "RUN_OWNED"],
      [{ ok: false, kind: "BUSY_LIMIT", message: "并发上限已满" }, -32013, "BUSY_LIMIT"],
    ];
    for (const [result, code, kind] of cases) {
      const h = harness({ sendPrompt: async () => result });
      const reply = await gatewayRpcReply(rpc("prompt.send", { sessionId: SESSION.id, text: "hi" }), h.deps);
      const failure = failureOf(reply);
      expect(failure.kind).toBe(kind);
      expect(failure.code).toBe(code);
      expect(failure.retryable, `${kind} 过一会儿重试有意义`).toBe(true);
      expect(failure.message).toBe(result.message);
    }
  });

  it("GW-W5: 会话不存在 / 无工作区 / 引擎未就绪 如实映射，且不可重试", async () => {
    const cases: Array<[GatewaySendPromptResult & { ok: false }, number]> = [
      [{ ok: false, kind: "NOT_FOUND", message: "会话不存在：x" }, -32003],
      [{ ok: false, kind: "NO_WORKSPACE", message: "没有工作区" }, -32015],
      [{ ok: false, kind: "ENGINE_UNAVAILABLE", message: "引擎未就绪" }, -32016],
    ];
    for (const [result, code] of cases) {
      const h = harness({ sendPrompt: async () => result });
      const reply = await gatewayRpcReply(rpc("prompt.send", { sessionId: SESSION.id, text: "hi" }), h.deps);
      const failure = failureOf(reply);
      expect(failure.code).toBe(code);
      expect(failure.kind).toBe(result.kind);
      expect(failure.retryable).toBe(false);
    }
  });

  it("GW-W6: requestId 幂等标记透传；没有 runId 的应答按内部错误处理", async () => {
    const h = harness({
      sendPrompt: async (input) => ({ ok: true, runId: "run-9", sessionId: input.sessionId, deduplicated: true }),
    });
    const reply = await gatewayRpcReply(
      rpc("prompt.send", { sessionId: SESSION.id, text: "hi", requestId: "chat-1-1", clientId: "c" }),
      h.deps,
    );
    expect(reply.result).toEqual({ runId: "run-9", sessionId: SESSION.id, deduplicated: true });

    const broken = harness({
      // 模拟注入方违约：受理了却没给 runId（无法取消/归属）
      sendPrompt: async (input) => ({ ok: true, runId: "", sessionId: input.sessionId }),
    });
    const failed = await gatewayRpcReply(rpc("prompt.send", { sessionId: SESSION.id, text: "hi" }), broken.deps);
    expect(failureOf(failed).kind).toBe("INTERNAL");
  });

  it("GW-W7: run.cancel 的四种应答：成功 / 已结束 / 找不到 / 别人家的", async () => {
    const ok = harness();
    const reply = await gatewayRpcReply(rpc("run.cancel", { runId: "run-1", clientId: "c" }), ok.deps);
    expect(reply.result).toEqual({
      runId: "run-1",
      sessionId: SESSION.id,
      cancelled: true,
      state: "running",
    });
    expect(ok.cancelled[0]).toEqual({ runId: "run-1", clientId: "c" });

    // 已经结束：不是错误（手机晚一步点停止很常见），如实说"没取消"。
    const finished = harness({
      cancelRun: (input): GatewayCancelRunResult => ({
        ok: true,
        runId: input.runId,
        sessionId: SESSION.id,
        cancelled: false,
        state: "finished",
      }),
    });
    const late = await gatewayRpcReply(rpc("run.cancel", { runId: "run-1" }), finished.deps);
    expect((late.result as any).cancelled).toBe(false);
    expect((late.result as any).state).toBe("finished");

    const missing = harness({
      cancelRun: (input): GatewayCancelRunResult => ({
        ok: false,
        kind: "RUN_NOT_FOUND",
        message: `没有这个网关运行（${input.runId}）`,
      }),
    });
    const notFound = await gatewayRpcReply(rpc("run.cancel", { runId: "run-x" }), missing.deps);
    expect(failureOf(notFound).kind).toBe("RUN_NOT_FOUND");
    expect(failureOf(notFound).code).toBe(-32014);

    const foreign = harness({
      cancelRun: (): GatewayCancelRunResult => ({
        ok: false,
        kind: "RUN_OWNED",
        message: "这次运行由另一台设备发起",
      }),
    });
    const owned = await gatewayRpcReply(rpc("run.cancel", { runId: "run-1" }), foreign.deps);
    expect(failureOf(owned).kind).toBe("RUN_OWNED");
    expect(failureOf(owned).code).toBe(-32012);
  });

  it("GW-W8: run.cancel 缺 runId → INVALID_PARAMS，不碰执行层", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(rpc("run.cancel", { clientId: "c" }), h.deps);
    expect(failureOf(reply).kind).toBe("INVALID_PARAMS");
    expect(h.cancelled).toHaveLength(0);
  });

  it("GW-W9: capabilities = 19 条（含审批/文件面/变更面/项目面/多设备同步）；事件不是 RPC 方法，不得混进两张表", async () => {
    const hello = await gatewayRpcReply(rpc("host.hello", { protocolVersion: 1 }), harness().deps);
    const caps = (hello.result as any).capabilities;
    // 结构固定：不允许偷偷加一个"看起来支持事件"的字段（半套 UI 的温床）。
    expect(Object.keys(caps).sort()).toEqual(["supported", "unsupported"]);
    expect(caps.supported).toEqual([...GATEWAY_RPC_METHODS]);
    expect(caps.unsupported).toEqual([...GATEWAY_UNSUPPORTED_METHODS]);
    // 同一个方法不许同时在两张表里（Host 侧 CAP-H1 踩过的形状：已实现却被灰掉）
    expect(caps.supported.filter((m: string) => caps.unsupported.includes(m))).toEqual([]);

    // M2：审批两条必须**如实**出现在 supported 里（手机据此渲染审批卡片）。
    for (const method of ["approval.list", "approval.respond"]) {
      expect(caps.supported).toContain(method);
      expect(caps.unsupported, `${method} 已实现，不能再列进未支持`).not.toContain(method);
    }
    // M3 变更面已实现：不能再列进 unsupported（否则手机把已实现功能灰掉）。
    for (const method of ["session.changes", "session.change.diff"]) {
      expect(caps.supported).toContain(method);
      expect(caps.unsupported).not.toContain(method);
    }
    // B1 项目面已实现：如实进 supported（手机据此渲染"新建会话/项目"）。
    for (const method of ["session.create", "project.list", "project.create"]) {
      expect(caps.supported).toContain(method);
      expect(caps.unsupported).not.toContain(method);
    }
    // 仍没实现的写路径：如实列在 unsupported 里（不画假按钮）。
    for (const method of ["run.guidance", "attachment.put"]) {
      expect(caps.supported).not.toContain(method);
      expect(caps.unsupported).toContain(method);
    }
    // 事件流（SSE）不是 RPC 方法：两个列表里都不该出现，避免被当成"已有事件 RPC"。
    expect(caps.supported).not.toContain("events");
    expect(caps.unsupported).not.toContain("events");

    const diag = await gatewayRpcReply(rpc("host.diagnostics"), harness().deps);
    expect((diag.result as any).readOnly, "M2 之后不再是只读网关").toBe(false);
  });
});
