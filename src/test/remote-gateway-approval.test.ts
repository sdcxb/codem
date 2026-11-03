/**
 * 网关审批 RPC 判据（GW-A1..GW-A6，ADR-0005 M2）。
 *
 * 审批是"手机能动手"的第二步：发送之后，真正危险的动作要能**在手机上被拒绝**。
 * 这组判据守的是：
 * 1. 读的是桌面**同一张**待批表（不是网关另存一份），字段映射只有一处；
 * 2. 答复只接受 allow/deny（**不**接受"总是允许"），且原样交给桌面代理裁决；
 * 3. 已被桌面/另一台设备/回合收口处理过的请求 → 明确的 `NOT_PENDING`（不是假装成功）；
 * 4. `session.get` 带上网关 run 的实时状态（刷新后仍能停）。
 */
import { describe, it, expect } from "vitest";

import {
  gatewayRpcReply,
  toGatewayApprovalItem,
  type GatewayApprovalAnswer,
  type GatewayApprovalListInput,
  type GatewayApprovalRespondInput,
  type GatewayApprovalView,
  type GatewayDataDeps,
} from "../core/remote/gateway-engine";

const SESSION = { id: "sess-approval-1", title: "桌面会话", projectId: "p1", projectName: "demo" };

const VIEW: GatewayApprovalView = {
  requestId: "perm-1",
  sessionId: SESSION.id,
  tool: "bash",
  preview: "command: npm run build",
  input: { command: "npm run build" },
  status: "open",
  revision: 3,
};

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 9, method, params });
}

interface Harness {
  deps: GatewayDataDeps;
  listed: GatewayApprovalListInput[];
  answered: GatewayApprovalRespondInput[];
}

function harness(overrides: Partial<GatewayDataDeps> = {}): Harness {
  const listed: GatewayApprovalListInput[] = [];
  const answered: GatewayApprovalRespondInput[] = [];
  const deps: GatewayDataDeps = {
    listSessions: () => [SESSION],
    getSession: () => ({ session: SESSION, messages: [], hasMore: false, run: null }),
    sendPrompt: async () => ({ ok: true, runId: "run-1", sessionId: SESSION.id }),
    cancelRun: (input) => ({
      ok: true,
      runId: input.runId,
      sessionId: SESSION.id,
      cancelled: true,
      state: "running",
    }),
    listApprovals: (input) => {
      listed.push(input);
      return [VIEW];
    },
    respondApproval: (input) => {
      answered.push(input);
      return { ok: true, approvalId: input.approvalId, decision: input.decision, decidedBy: "phone" };
    },
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
    ...overrides,
  };
  return { deps, listed, answered };
}

function failure(reply: Record<string, unknown>): {
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

describe("网关审批（M2）", () => {
  it("GW-A1: approval.list 读桌面同一张表，字段映射只有一处", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(rpc("approval.list", {}), h.deps);
    expect((reply.result as any).approvals).toEqual([toGatewayApprovalItem(VIEW)]);
    // 不传 sessionId = 全部会话；不传 includeDecided = 只要待批
    expect(h.listed).toEqual([{ includeDecided: false }]);

    const scoped = harness();
    await gatewayRpcReply(
      rpc("approval.list", { sessionId: SESSION.id, includeDecided: true }),
      scoped.deps,
    );
    expect(scoped.listed).toEqual([{ sessionId: SESSION.id, includeDecided: true }]);

    // 映射函数的字段是协议的一部分：手机卡片只认这四个 + 状态/版本
    expect(toGatewayApprovalItem(VIEW)).toEqual({
      approvalId: "perm-1",
      tool: "bash",
      summary: "command: npm run build",
      details: { command: "npm run build" },
      status: "open",
      revision: 3,
    });
  });

  it("GW-A2: approval.respond 只接受 allow/deny，且不提供「总是允许」后门", async () => {
    for (const params of [
      {},
      { approvalId: "   ", decision: "allow" },
      { approvalId: "perm-1" },
      { approvalId: "perm-1", decision: "always-allow" },
      { approvalId: "perm-1", decision: "allow-once" },
    ]) {
      const h = harness();
      const reply = await gatewayRpcReply(rpc("approval.respond", params), h.deps);
      expect(failure(reply).kind, JSON.stringify(params)).toBe("INVALID_PARAMS");
      expect(h.answered, "非法参数不得触碰审批代理").toHaveLength(0);
    }

    const h = harness();
    const reply = await gatewayRpcReply(
      // alwaysAllow 是**代理层刻意没有**的通道：即使客户端塞进来也必须被忽略。
      rpc("approval.respond", { approvalId: "perm-1", decision: "deny", alwaysAllow: true }),
      h.deps,
    );
    expect(reply.result).toEqual({ approvalId: "perm-1", decision: "deny", decidedBy: "phone" });
    expect(h.answered).toEqual([{ approvalId: "perm-1", decision: "deny" }]);
  });

  it("GW-A3: 已被处理的审批 → NOT_PENDING（可行动，不假装成功）", async () => {
    const h = harness({
      respondApproval: (): GatewayApprovalAnswer => ({
        ok: false,
        kind: "NOT_PENDING",
        message: "这个权限请求已处理或已失效。",
      }),
    });
    const reply = await gatewayRpcReply(
      rpc("approval.respond", { approvalId: "perm-1", decision: "allow" }),
      h.deps,
    );
    const out = failure(reply);
    expect(out.kind).toBe("NOT_PENDING");
    expect(out.code).toBe(-32021);
    expect(out.message).toContain("已处理");
    // 重试同一个答复没有意义（一次性授权），界面据此收起卡片而不是提示"重试"。
    expect(out.retryable).toBe(false);
  });

  it("GW-A4: 非法动作（代理裁决）→ INVALID_ACTION 独立错误码", async () => {
    const h = harness({
      respondApproval: (): GatewayApprovalAnswer => ({
        ok: false,
        kind: "INVALID_ACTION",
        message: "未知的批准操作。",
      }),
    });
    const reply = await gatewayRpcReply(
      rpc("approval.respond", { approvalId: "perm-1", decision: "allow" }),
      h.deps,
    );
    expect(failure(reply).kind).toBe("INVALID_ACTION");
    expect(failure(reply).code).toBe(-32022);
  });

  it("GW-A5: session.get 带上网关 run 的实时状态；没有时如实 null", async () => {
    const live = harness({
      getSession: () => ({
        session: SESSION,
        messages: [],
        hasMore: false,
        run: { runId: "run-live", state: "running" },
      }),
    });
    const got = await gatewayRpcReply(rpc("session.get", { sessionId: SESSION.id }), live.deps);
    expect((got.result as any).run).toEqual({ runId: "run-live", state: "running" });

    const idle = harness();
    const none = await gatewayRpcReply(rpc("session.get", { sessionId: SESSION.id }), idle.deps);
    expect((none.result as any).run).toBeNull();
  });

  it("GW-A6: sessionId 给空串是参数错误（不静默退化成「全部会话」）", async () => {
    const h = harness();
    const reply = await gatewayRpcReply(rpc("approval.list", { sessionId: "   " }), h.deps);
    expect(failure(reply).kind).toBe("INVALID_PARAMS");
    expect(h.listed).toHaveLength(0);
  });
});
