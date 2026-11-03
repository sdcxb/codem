/**
 * 判据：目标模式的自动入口（GOAL-1）、审计链（GOAL-15）、以及 **SQLite 存储往返 + 重启恢复**（GOAL-10）。
 *
 * 存储层判据用 `vi.mock` 顶替 `domain-store`：被验证的是 `SqliteGoalStore` 的
 * **行映射**（snake_case、JSON 列、布尔→0/1、缺列不丢字段）—— 那是"重启后读回来还是同一个目标"
 * 的真实边界；`domain-store` 本身的镜像/写穿另有它的判据（DOM-*）。
 */
import { describe, expect, it, vi } from "vitest";

// ---- domain-store 的进程内替身（hoisted：vi.mock 工厂不能引用普通外层变量） ----
const db = vi.hoisted(() => {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  return {
    tables,
    reset() {
      tables.clear();
    },
  };
});

vi.mock("../core/storage/domain-store", () => ({
  domainWrite: (table: string, rows: Array<Record<string, unknown>>) => {
    const list = db.tables.get(table) ?? [];
    for (const row of rows) {
      const idx = list.findIndex((r) => r.id === row.id);
      if (idx >= 0) list[idx] = row;
      else list.push(row);
    }
    db.tables.set(table, list);
    return true;
  },
  domainReadMany: (
    table: string,
    convert: (row: Record<string, unknown>) => unknown,
    where?: Record<string, unknown>,
  ) => {
    const list = db.tables.get(table) ?? [];
    const rows = where ? list.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)) : list;
    return rows.map(convert);
  },
  domainReadOne: (
    table: string,
    where: Record<string, unknown>,
    convert: (row: Record<string, unknown>) => unknown,
  ) => {
    const list = db.tables.get(table) ?? [];
    const row = list.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    return row ? convert(row) : null;
  },
}));

import { SqliteGoalStore, createMemoryGoalStore } from "../core/goal/store";
import type { GoalStore } from "../core/goal/store";
import { GoalRunner } from "../core/goal/runner";
import { looksMultiPhaseRequest, maybeStartGoalMode } from "../core/goal/runtime";
import type { GoalPlan, PlanPhase } from "../core/goal/types";

const SESSION = "s-goal-runtime";

function phase(key: string, order: number, dep: string[]): PlanPhase {
  return {
    key,
    order,
    title: `${key} 里程碑`,
    outcome: `${key} 的交付物已经可用`,
    acceptance: [{ id: `${key}.a1`, kind: "command", description: `${key} 验收`, command: "npm test" }],
    covers: ["A1"],
    dependsOn: dep,
    risks: [],
    status: "pending",
    attempts: 0,
  };
}

function makePlan(goalId: string): GoalPlan {
  return {
    goalId,
    version: 1,
    contractVersion: 1,
    strategy: "先数据层，再端到端，最后兼容性确认",
    invariants: ["不破坏既有行为"],
    phases: [phase("p1", 0, []), phase("p2", 1, ["p1"]), phase("p3", 2, ["p2"])],
    createdAt: 1,
  };
}

// ========== GOAL-1 ==========

describe("GOAL-1 多阶段自动建目标 / 单阶段与问答不建", () => {
  it("预判只过滤明显不是的：多交付物任务进入规划，问答/微步不进入", () => {
    expect(
      looksMultiPhaseRequest(
        "把导出链路做对：1. 补齐协议层字段 2. 更新 UI 消费方 3. 补端到端回归测试，最后要能跨模块验证",
      ),
    ).toBe(true);
    expect(looksMultiPhaseRequest("解释一下这个函数为什么这么写？")).toBe(false);
    expect(looksMultiPhaseRequest("帮我看看这个报错怎么修")).toBe(false);
    expect(looksMultiPhaseRequest("重构一下这个文件")).toBe(false);
  });

  it("规划器判 multi-phase ⇒ 建目标 + 里程碑计划 + 自动开始执行", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const turns: string[] = [];
    const result = await maybeStartGoalMode({
      sessionId: SESSION,
      message: "把导出链路做对：1. 补齐协议字段 2. 更新消费方 3. 补端到端回归测试",
      cwd: "C:\\repo",
      engine: {} as never,
      store,
      complete: async () => JSON.stringify(multiPlanDraft()),
      runTurn: async (args) => {
        turns.push(args.messageId ?? "");
        return { output: "ok", toolCallCount: 1, success: true };
      },
      runAcceptance: async (a) => ({ acceptance: a, passed: true, summary: "ok", durationMs: 1 }),
    });

    expect(result.handled).toBe(true);
    const goal = store.getLatestGoalForSession(SESSION);
    expect(goal, "多阶段任务必须自动建目标").toBeTruthy();
    expect(goal!.acceptance.length).toBeGreaterThan(0);
    const plan = store.getActivePlan(goal!.id)!;
    expect(plan.phases.length).toBe(3);
    // 自动开始：第一个阶段的回合已经发出（不需要用户点任何按钮）
    await new Promise((r) => setTimeout(r, 0));
    expect(turns[0], "建完目标要自动开始第一阶段").toContain("goal-phase-");
  });

  it("规划器判 single-phase / question ⇒ 不建目标（回落 run 自主）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const runTurn = vi.fn();
    const single = await maybeStartGoalMode({
      sessionId: SESSION,
      message: "实现一个端到端导出功能并补回归测试，分三步来做，最后验证跨模块",
      cwd: "C:\\repo",
      engine: {} as never,
      store,
      complete: async () => JSON.stringify({ classification: "single-phase", reason: "一个交付物" }),
      runTurn,
    });
    expect(single.handled).toBe(false);
    expect(store.getLatestGoalForSession(SESSION), "单阶段不该建目标").toBeNull();

    const question = await maybeStartGoalMode({
      sessionId: SESSION,
      message: "解释一下端到端测试怎么做，分几步",
      cwd: "C:\\repo",
      engine: {} as never,
      store,
      complete: async () => JSON.stringify({ classification: "question", reason: "纯问答" }),
      runTurn,
    });
    expect(question.handled).toBe(false);
    expect(store.getLatestGoalForSession(SESSION)).toBeNull();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("已有活跃目标 ⇒ 不重复建（单会话单 active goal）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    store.createGoal({
      sessionId: SESSION,
      statement: "已有目标",
      principles: [],
      nonGoals: [],
      acceptance: [{ id: "A1", kind: "test", description: "a", command: "c" }],
      constraints: [],
    }, { id: "goal-live" });
    const result = await maybeStartGoalMode({
      sessionId: SESSION,
      message: "再来一个多阶段任务：1. 甲 2. 乙 3. 丙，最后跨模块验证",
      cwd: "C:\\repo",
      engine: {} as never,
      store,
      complete: async () => JSON.stringify(multiPlanDraft()),
    });
    expect(result.handled).toBe(false);
    if (!result.handled) expect(result.reason).toBe("already-active");
    expect(store.listGoalsForSession(SESSION)).toHaveLength(1);
  });
});

function multiPlanDraft() {
  return {
    classification: "multi-phase",
    statement: "把导出链路做对，并且回归测试证明它不再丢字段",
    principles: ["不破坏既有行为"],
    nonGoals: ["不改 UI 文案"],
    constraints: ["Node 24"],
    goalAcceptance: [{ kind: "test", description: "整体回归为绿", command: "npm test" }],
    strategy: "先数据层，再端到端，最后兼容性确认",
    invariants: ["不破坏既有行为"],
    phases: [
      {
        key: "p1",
        title: "字段补齐",
        outcome: "导出结果包含全部约定字段，并有单测覆盖",
        covers: ["A1"],
        acceptance: [{ kind: "test", description: "单测为绿", command: "npm test" }],
        dependsOn: [],
        risks: [],
      },
      {
        key: "p2",
        title: "端到端回归",
        outcome: "端到端导出不再丢字段，回归测试为绿",
        covers: ["A1"],
        acceptance: [{ kind: "test", description: "端到端为绿", command: "npm test" }],
        dependsOn: ["p1"],
        risks: [],
      },
      {
        key: "p3",
        title: "兼容性确认",
        outcome: "旧消费方仍可读取新结果（向后兼容）",
        covers: ["A1"],
        acceptance: [{ kind: "command", description: "旧消费方脚本退出码 0", command: "node compat.mjs" }],
        dependsOn: ["p2"],
        risks: [],
      },
    ],
  };
}

// ========== GOAL-15 ==========

describe("GOAL-15 可审计：计划版本 / 阶段证据 / 重规划原因都能查", () => {
  it("跑完一个目标后：决策链完整、证据逐条可查、计划版本可列", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const goal = store.createGoal({
      sessionId: "s-audit",
      statement: "审计目标",
      principles: [],
      nonGoals: [],
      acceptance: [{ id: "A1", kind: "test", description: "整体", command: "npm test" }],
      constraints: [],
    }, { id: "goal-audit" });
    store.savePlan(makePlan(goal.id));

    const runner = new GoalRunner({
      store,
      runTurn: async () => ({ output: "ok", toolCallCount: 0, success: true }),
      runAcceptance: (() => {
        // 第一次验收失败（触发 auto_continue），之后全部通过
        const queue = [false, true];
        return async (a: import("../core/goal/types").Acceptance) => ({
          acceptance: a,
          passed: queue.length > 0 ? queue.shift()! : true,
          summary: `${a.id} result`,
          durationMs: 1,
        });
      })(),
    });
    const outcome = await runner.run({ goalId: goal.id, cwd: "C:\\repo", signal: new AbortController().signal });
    expect(outcome.kind).toBe("completed");

    const decisions = store.listDecisions(goal.id);
    const kinds = decisions.map((d) => d.kind);
    expect(kinds).toContain("phase_started");
    expect(kinds).toContain("phase_passed");
    expect(kinds, "无 tool call 的自动继续必须留痕（A1）").toContain("auto_continue");
    expect(kinds).toContain("goal_completed");
    expect(decisions.every((d) => d.reason.trim().length > 0), "决策不许空原因").toBe(true);

    const evidence = store.listEvidence(goal.id);
    expect(evidence.length).toBeGreaterThanOrEqual(4); // 3 阶段 + 整体验收
    expect(evidence.every((e) => e.acceptanceId && e.summary && e.planVersion === 1)).toBe(true);
    expect(store.listPlans(goal.id).map((p) => p.version)).toEqual([1]);
  });
});

// ========== GOAL-10（存储往返） ==========

describe("GOAL-10 持久化：重启后读回来的目标/计划/阶段/证据与内存一致，已完成阶段不重跑", () => {
  it("SqliteGoalStore 往返保真（含 JSON 列/布尔/usage），新实例能继续未完成阶段", async () => {
    db.reset();
    const first = new SqliteGoalStore(() => 1000);
    const goal = first.createGoal({
      sessionId: "s-persist",
      statement: "持久化目标",
      principles: ["原则 A"],
      nonGoals: ["不做 B"],
      acceptance: [{ id: "A1", kind: "test", description: "整体", command: "npm test" }],
      constraints: ["C"],
      budget: { mode: "capped", maxTokens: 1234 },
      maxReplans: 7,
    }, { id: "goal-persist", now: 1000 });
    first.savePlan(makePlan(goal.id));
    first.updatePhase(goal.id, 1, "p1", { status: "done", attempts: 2, completedAt: 1100 });
    first.addEvidence({
      id: "ev-persist",
      goalId: goal.id,
      planVersion: 1,
      phaseKey: "p1",
      attempt: 2,
      kind: "command",
      acceptanceId: "p1.a1",
      summary: "p1 通过",
      detail: "输出尾部",
      passed: true,
      createdAt: 1100,
    });
    first.addDecision({
      id: "gd-persist",
      goalId: goal.id,
      kind: "phase_passed",
      reason: "p1 通过",
      planVersion: 1,
      phaseKey: "p1",
      payload: { note: "审计" },
      createdAt: 1100,
    });
    first.updateGoal(goal.id, {
      status: "paused",
      blockedReason: "稍后继续",
      usage: { tokens: 900, turns: 3, startedAt: 1000 },
    });

    // ---- "重启"：新实例只靠库里的行重建 ----
    const second = new SqliteGoalStore(() => 2000);
    const restored = second.getGoal(goal.id);
    expect(restored).toBeTruthy();
    expect(restored!.statement).toBe("持久化目标");
    expect(restored!.principles).toEqual(["原则 A"]);
    expect(restored!.nonGoals).toEqual(["不做 B"]);
    expect(restored!.acceptance[0]).toMatchObject({ id: "A1", kind: "test", command: "npm test" });
    expect(restored!.budget).toEqual({ mode: "capped", maxTokens: 1234 });
    expect(restored!.maxReplans).toBe(7);
    expect(restored!.usage).toEqual({ tokens: 900, turns: 3, startedAt: 1000 });
    expect(restored!.status).toBe("paused");
    expect(restored!.blockedReason).toBe("稍后继续");

    const plan = second.getActivePlan(goal.id)!;
    expect(plan.phases.map((p) => p.key)).toEqual(["p1", "p2", "p3"]);
    expect(plan.phases[0].status, "已完成阶段必须保留").toBe("done");
    expect(plan.phases[0].acceptance[0].command).toBe("npm test");
    expect(plan.contractVersion).toBe(1);

    const evidence = second.listEvidence(goal.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].passed, "布尔必须往返保真（存 1 读 true）").toBe(true);
    expect(evidence[0].detail).toBe("输出尾部");

    const decisions = second.listDecisions(goal.id);
    expect(decisions[0].payload).toEqual({ note: "审计" });

    // ---- 恢复执行：不重跑 p1 ----
    // 预算改成 unlimited：本用例关心的是"恢复后不重跑已完成阶段"，不是 capped 的暂停语义
    // （capped 的暂停已由 goal-runner.test.ts 的 GOAL-11 覆盖）。
    second.replaceContract({ ...second.getGoal(goal.id)!, status: "active", budget: { mode: "unlimited" } });
    const turns: string[] = [];
    const runner = new GoalRunner({
      store: second,
      runTurn: async (args) => {
        turns.push(args.messageId ?? "");
        return { output: "ok", toolCallCount: 1, success: true };
      },
      runAcceptance: async (a) => ({ acceptance: a, passed: true, summary: "ok", durationMs: 1 }),
    });
    const outcome = await runner.run({ goalId: goal.id, cwd: "C:\\repo", signal: new AbortController().signal });
    expect(outcome.kind).toBe("completed");
    expect(turns.length, "只剩 p2/p3").toBe(2);
    expect(turns.join(",")).not.toContain("-p1-");
  });

  it("一个会话最多一个 active goal（第二个创建会抛错，而不是静默覆盖）", () => {
    db.reset();
    const store: GoalStore = new SqliteGoalStore(() => 1000);
    store.createGoal({
      sessionId: "s-one",
      statement: "第一",
      principles: [],
      nonGoals: [],
      acceptance: [{ id: "A1", kind: "test", description: "a", command: "c" }],
      constraints: [],
    }, { id: "g1" });
    expect(() =>
      store.createGoal({
        sessionId: "s-one",
        statement: "第二",
        principles: [],
        nonGoals: [],
        acceptance: [{ id: "A1", kind: "test", description: "a", command: "c" }],
        constraints: [],
      }, { id: "g2" }),
    ).toThrow(/一个会话最多一个 active goal/);
  });
});

