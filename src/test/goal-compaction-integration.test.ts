/**
 * 判据：**真实压缩路径**（`AgenticLoop.compactMessages`）在目标模式下写检查点、
 * 压缩后目标上下文仍然注入、且不重规划/不丢阶段（A2 / GOAL-17 的接线级证明）。
 *
 * 为什么不能只测 `writeGoalCompactionCheckpoint()`：那只是函数本身；
 * 这一条走的是循环内部真正被触发的压缩入口，**接线断了会红**。
 */
import { describe, expect, it, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { createMemoryGoalStore } from "../core/goal/store";
import type { GoalPlan, PlanPhase } from "../core/goal/types";

const SESSION = "s-goal-compaction";
const CWD = "C:\\goal-compaction";

const listMessagesMock = vi.fn();
const deleteMessagesByIdsMock = vi.fn();
const createMessageMock = vi.fn();

vi.mock("../core/storage/message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/message")>();
  return {
    isHiddenStateAuthoritative: () => true,
    ...actual,
    listMessages: (...a: unknown[]) => listMessagesMock(...a),
    listVisibleMessages: (...a: unknown[]) => listMessagesMock(...a),
    deleteMessagesByIds: (...a: unknown[]) => deleteMessagesByIdsMock(...a),
    getLastDeleteReport: vi.fn(() => ({ requested: 0, unresolved: 0, sessions: [], softDeleteResponded: true })),
    createMessage: (...a: unknown[]) => createMessageMock(...a),
    getLastPersistError: () => null,
    flushPendingPersist: async () => true,
  };
});

vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async () => {},
  appendMessageTombstone: async () => {},
  readSessionMessages: () => [],
  hiddenFlagOf: () => 0,
  trimmedFlagOf: () => 0,
  isCompressedHidden: () => false,
  durableMessageIds: async () => [],
  flushSessionLogWrites: async () => {},
}));

class EchoProvider {
  id = "goal-compaction-provider";
  name = "Goal Compaction Mock";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "done" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "压缩摘要", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

function activePhase(): PlanPhase {
  return {
    key: "p1",
    order: 0,
    title: "数据层",
    outcome: "数据层可用",
    acceptance: [{ id: "p1.a1", kind: "command", description: "回归", command: "npm test" }],
    covers: ["A1"],
    dependsOn: [],
    risks: [],
    status: "active",
    attempts: 1,
  };
}

function seedGoal(store: ReturnType<typeof createMemoryGoalStore>) {
  const goal = store.createGoal(
    {
      sessionId: SESSION,
      statement: "把导出链路做对",
      principles: ["不破坏既有行为"],
      nonGoals: [],
      acceptance: [{ id: "A1", kind: "test", description: "回归", command: "npm test" }],
      constraints: [],
    },
    { id: "goal-compaction", now: 1 },
  );
  const plan: GoalPlan = {
    goalId: goal.id,
    version: 1,
    contractVersion: 1,
    strategy: "先数据层再端到端",
    invariants: ["不破坏既有行为"],
    phases: [activePhase(), { ...activePhase(), key: "p2", order: 1, dependsOn: ["p1"], status: "pending" }],
    createdAt: 1,
  };
  store.savePlan(plan);
  return goal;
}

function longMessages(turns: number) {
  const out: any[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ id: `u${t}`, role: "user", content: `第 ${t} 轮：${"问".repeat(240)}`, timestamp: t * 10 });
    out.push({
      id: `a${t}`,
      role: "assistant",
      content: `第 ${t} 轮回答：${"答".repeat(240)}`,
      timestamp: t * 10 + 1,
      toolCalls: [{ id: `tc${t}`, tool: "read", args: { path: `f${t}` }, result: "结果".repeat(40) }],
    });
  }
  return out;
}

describe("A2：真实压缩路径写检查点，且压缩后目标仍注入", () => {
  it("compactMessages() 写 phase_checkpoint + phase_resumed（同一阶段/同一批验收）", async () => {
    const store = createMemoryGoalStore(() => 1);
    seedGoal(store);

    listMessagesMock.mockReturnValue(longMessages(14));
    deleteMessagesByIdsMock.mockReturnValue({
      requested: 10,
      unresolved: 0,
      softDeleteIncomplete: false,
      sessions: [{ sessionId: SESSION, removed: 10, kept: 18 }],
    });
    createMessageMock.mockReturnValue({ id: "marker-1", role: "assistant", content: "摘要", timestamp: 999 });

    const provider = new EchoProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 2,
      model: "goal-model",
      securityMode: "full",
      goalStore: store,
    });

    const removed = await (loop as any).compactMessages(SESSION);
    expect(removed, "压缩本身必须真的执行（不是跳过）").toBeGreaterThan(0);

    const list = store.listDecisions("goal-compaction");
    const kinds = list.map((d) => d.kind);
    expect(kinds, "压缩前必须留 phase_checkpoint").toContain("phase_checkpoint");
    expect(kinds, "压缩后必须留 phase_resumed").toContain("phase_resumed");

    const checkpoint = list.find((d: any) => d.kind === "phase_checkpoint");
    expect(checkpoint?.phaseKey).toBe("p1");
    expect(JSON.stringify(checkpoint?.payload ?? {})).toContain("p1.a1");
    expect(store.getGoal("goal-compaction")?.status, "检查点不得把目标阻塞/取消").toBe("active");
    expect(store.getActivePlan("goal-compaction")?.phases.find((p) => p.key === "p1")?.status).toBe("active");
  });

  it("压缩之后下一轮请求的尾部仍有 Goal Mode，system 前缀仍没有", async () => {
    const store = createMemoryGoalStore(() => 1);
    seedGoal(store);
    listMessagesMock.mockReturnValue(longMessages(2));

    const provider = new EchoProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 2,
      model: "goal-model",
      securityMode: "full",
      goalStore: store,
    });
    for await (const _e of loop.run(SESSION, "继续", CWD, "system prompt")) {
      /* drain */
    }
    const req = provider.requests[0];
    const trailing = req?.messages?.filter((m: any) => m.role === "user").at(-1);
    expect(String(trailing?.content ?? ""), "压缩与否都不影响：目标段来自存储，每轮重算").toContain("# Goal Mode");
    expect(String(req.messages[0].content ?? "")).not.toContain("# Goal Mode");
  });
});
