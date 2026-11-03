/**
 * 判据：目标上下文**每轮固定注入**、压缩检查点、以及压缩造成的配对冲突处置
 * （GOAL-12 / GOAL-17 / GOAL-18）。
 *
 * 三条被钉住的事实：
 *
 * 1. **上下文不依赖对话历史**：`buildGoalModeContext` 只读存储（契约/计划/当前阶段/验收/证据），
 *    所以压缩删掉多少旧消息都不影响它 —— 这是 GOAL-12 的结构性答案；
 * 2. **真的到达模型**：用脚本化 provider 拦请求本体（抄 `goal-injection.test.ts` 的做法，
 *    因为"源码里有注入代码"曾经假绿过），断言每轮请求的**尾部 user 消息**里有目标模式段，
 *    而 system 前缀里没有（前缀缓存纪律）；
 * 3. **压缩是可审计的检查点事件**：压缩前写 `phase_checkpoint`、压缩后写 `phase_resumed`；
 *    若上下文精简把工具配对切开 ⇒ 目标 `blocked(context_conflict)`，原因可见，
 *    **普通会话不受影响**（反向对照）。
 */
import { describe, expect, it } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { buildGoalModeContext, buildGoalView } from "../core/goal/context";
import {
  finishGoalCompactionCheckpoint,
  reportGoalContextConflict,
  writeGoalCompactionCheckpoint,
} from "../core/goal/checkpoint";
import { createMemoryGoalStore } from "../core/goal/store";
import type { GoalStore } from "../core/goal/store";
import type { GoalPlan, PlanPhase } from "../core/goal/types";

const SESSION = "s-goal-context";
const CWD = "C:\\goal-context";
const PROBE = "goal_ctx_probe";

function phase(key: string, order: number, dependsOn: string[], status: PlanPhase["status"] = "pending"): PlanPhase {
  return {
    key,
    order,
    title: `${key} 的里程碑`,
    outcome: `${key} 的交付物已经可用`,
    acceptance: [
      { id: `${key}.a1`, kind: "command", description: `${key} 命令验收`, command: "npm test", expectExitCode: 0 },
    ],
    covers: ["A1"],
    dependsOn,
    risks: [],
    status,
    attempts: 0,
  };
}

function seed(store: GoalStore, opts: { phases?: PlanPhase[]; sessionId?: string } = {}) {
  const sessionId = opts.sessionId ?? SESSION;
  const goal = store.createGoal({
    sessionId,
    statement: "把导出链路做对，且回归测试证明不再丢字段",
    principles: ["不破坏既有行为"],
    nonGoals: ["不改 UI 文案"],
    acceptance: [{ id: "A1", kind: "test", description: "整体回归为绿", command: "npm test" }],
    constraints: ["Node 24"],
  }, { id: `goal-${sessionId}`, now: 1 });
  const plan: GoalPlan = {
    goalId: goal.id,
    version: 1,
    contractVersion: 1,
    strategy: "先数据层，再端到端，最后兼容性确认",
    invariants: ["不破坏既有行为"],
    phases: opts.phases ?? [phase("p1", 0, [], "active"), phase("p2", 1, ["p1"]), phase("p3", 2, ["p2"])],
    createdAt: 1,
  };
  store.savePlan(plan);
  return { goal, plan };
}

// ========== 脚本化 provider（拦请求本体） ==========

class RecordingProvider {
  id = "goal-ctx-provider";
  name = "Goal Context Mock";
  requests: any[] = [];
  private queue: any[][] = [];
  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.queue.shift() ?? [{ type: "text_delta", text: "done" }, { type: "end", finishReason: "stop" }];
    for (const item of script) yield item;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

function registryWithProbe() {
  const registry = createDefaultToolRegistry();
  registry.register({
    id: PROBE,
    description: "测试探针",
    parameters: { type: "object", properties: {}, required: [] },
    contract: { readOnly: true, sideEffectScope: "none", accessScope: "none", persistResult: false },
    async execute() {
      return { title: "probe", output: "ok" };
    },
  } as any);
  return registry;
}

function probeIteration(): any[] {
  const id = "call_probe_ctx";
  return [
    { type: "tool_use_start", id, name: PROBE },
    { type: "tool_use_delta", id, input: JSON.stringify({}) },
    { type: "tool_use_end", id, input: {} },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(): any[] {
  return [{ type: "text_delta", text: "本轮结束" }, { type: "end", finishReason: "stop" }];
}

async function runTwoIterations(store: GoalStore | null): Promise<any[]> {
  const provider = new RecordingProvider();
  provider.setScript([probeIteration(), finalIteration()]);
  const loop = new AgenticLoop(provider as any, registryWithProbe(), {
    maxIterations: 4,
    model: "goal-model",
    securityMode: "full",
    ...(store ? { goalStore: store } : {}),
  });
  for await (const _e of loop.run(SESSION, "继续", CWD, "system prompt")) {
    /* drain */
  }
  return provider.requests;
}

function goalModeMessage(request: any): any | undefined {
  return request?.messages?.find((m: any) => String(m.content ?? "").includes("# Goal Mode"));
}

// ========== GOAL-12 ==========

describe("GOAL-12 目标上下文不依赖对话历史（每轮从存储重算）", () => {
  it("上下文段包含契约/计划/当前阶段/验收/证据，且重复调用逐字一致（无历史输入）", () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    store.addEvidence({
      id: "ev-1",
      goalId: goal.id,
      planVersion: 1,
      phaseKey: "p1",
      attempt: 1,
      kind: "command",
      acceptanceId: "p1.a1",
      summary: "p1.a1 失败：退出码 1",
      passed: false,
      createdAt: 2,
    });

    const first = buildGoalModeContext(SESSION, { store });
    const second = buildGoalModeContext(SESSION, { store });

    expect(first).toContain("Goal Mode");
    expect(first, "契约 statement").toContain("把导出链路做对");
    expect(first, "里程碑计划").toContain("p2 的里程碑");
    expect(first, "当前阶段").toContain("当前阶段 p1");
    expect(first, "阶段验收").toContain("npm test");
    expect(first, "最近证据").toContain("p1.a1 失败");
    expect(first, "不变式/预算必须可见").toContain("unlimited");
    expect(second, "重复调用必须一致（不累积、不依赖上一轮）").toBe(first);
  });

  it("没有活跃目标 ⇒ 一个字都不注入（不是一段固定文本）", () => {
    const store = createMemoryGoalStore(() => 1000);
    expect(buildGoalModeContext("s-no-goal", { store })).toBe("");
  });

  it("真的到达模型：每轮请求的尾部 user 消息都有目标段；system 前缀没有", async () => {
    const store = createMemoryGoalStore(() => 1000);
    seed(store);
    const requests = await runTwoIterations(store);
    expect(requests.length, "探针必须把循环推进到第 2 轮").toBeGreaterThanOrEqual(2);

    for (const [i, req] of requests.entries()) {
      const msg = goalModeMessage(req);
      expect(msg, `第 ${i + 1} 轮请求必须带上目标模式上下文`).toBeTruthy();
      const last = req.messages[req.messages.length - 1];
      expect(last, "目标上下文必须走尾部消息（易变内容不进前缀）").toBe(msg);
      expect(String(msg.content)).toContain("p1 的里程碑");
      expect(String(msg.content)).toContain("npm test");
      expect(String(req.messages[0].content), "system 前缀里不许有易变的目标段").not.toContain("# Goal Mode");
    }
  });

  it("反向对照：没有目标时请求里不出现目标段", async () => {
    const requests = await runTwoIterations(null);
    for (const req of requests) {
      expect(goalModeMessage(req), "没有目标却注入了一段固定文本 —— 那说明这段是常量").toBeUndefined();
    }
  });
});

// ========== GOAL-17 ==========

describe("GOAL-17 压缩前检查点 / 压缩后恢复（不重规划、不丢验收）", () => {
  it("压缩前写 phase_checkpoint（含未完成验收），压缩后写 phase_resumed", () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);

    const checkpoint = writeGoalCompactionCheckpoint(SESSION, store);
    expect(checkpoint, "有活跃目标时必须返回检查点").toBeTruthy();
    expect(checkpoint!.phaseKey).toBe("p1");
    expect(checkpoint!.pendingAcceptanceIds).toEqual(["p1.a1"]);
    const decisions = store.listDecisions(goal.id);
    expect(decisions.some((d) => d.kind === "phase_checkpoint")).toBe(true);

    finishGoalCompactionCheckpoint(checkpoint, 42, store);
    const after = store.listDecisions(goal.id);
    const resumed = after.find((d) => d.kind === "phase_resumed")!;
    expect(resumed).toBeTruthy();
    expect(resumed.reason).toContain("42");

    // 压缩后从存储重算的上下文仍然完整（没有重新规划、阶段也没变）
    const context = buildGoalModeContext(SESSION, { store });
    expect(context).toContain("当前阶段 p1");
    expect(context).toContain("p1.a1");
    expect(store.getActivePlan(goal.id)!.version, "压缩不该触发重规划").toBe(1);
    expect(store.listPhases(goal.id, 1).find((p) => p.key === "p1")!.status).toBe("active");
  });

  it("没有活跃目标 ⇒ 检查点是零成本 no-op（普通会话压缩不受影响）", () => {
    const store = createMemoryGoalStore(() => 1000);
    expect(writeGoalCompactionCheckpoint("s-plain", store)).toBeNull();
    finishGoalCompactionCheckpoint(null, 10, store); // 不抛
    expect(reportGoalContextConflict("s-plain", "x", store), "普通会话不该被阻塞").toBe(false);
  });
});

// ========== GOAL-18 ==========

describe("GOAL-18 压缩把工具配对切开 ⇒ blocked(context_conflict) 且原因可见", () => {
  it("有活跃目标：目标被 blocked，原因写明 context_conflict，视图里看得到", () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);

    const blocked = reportGoalContextConflict(SESSION, "剥掉 2 个调用 / 0 条结果", store);
    expect(blocked).toBe(true);

    const after = store.getGoal(goal.id)!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("context_conflict");
    expect(after.blockedReason, "原因必须具体（剥了多少）").toContain("2 个调用");

    const view = buildGoalView(SESSION, { store });
    expect(view?.status).toBe("blocked");
    expect(view?.blockedReason).toContain("context_conflict");
    expect(store.listDecisions(goal.id).some((d) => d.kind === "goal_blocked")).toBe(true);
  });

  it("预算 capped 达限：暂停而不是失败，视图里保留原因（与 blocked 区分）", () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    store.updateGoal(goal.id, { status: "paused", blockedReason: "达到预算上限：回合数 3 ≥ 3" });
    const view = buildGoalView(SESSION, { store });
    expect(view?.status).toBe("paused");
    expect(view?.blockedReason).toContain("预算");
  });
});
