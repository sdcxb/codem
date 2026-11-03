/**
 * 判据：Goal Runner 的阶段调度与门禁（GOAL-4/5/6/7/8/10/11/13/14/16）。
 *
 * 这个文件**不碰真模型、不碰真命令**：`runTurn` / `runAcceptance` / `replan` 都是注入的假实现。
 * 被验证的是调度语义本身 ——
 * 阶段门禁以证据为准、阶段自动推进、阶段内自动继续、无进展熔断、预算、审批、停止、
 * 重启恢复不重跑已完成阶段、重规划保留已完成阶段。
 */
import { describe, expect, it, vi } from "vitest";

/**
 * 默认验收（GOAL-19）需要文件层：这里用一个最小替身记录"读到哪个路径"。
 * 其余用例全部注入 `runAcceptance`，不会碰它。
 */
const fileApi = vi.hoisted(() => ({ seen: [] as string[], content: "[]" }));
vi.mock("../core/file-api", () => ({
  readFile: async (path: string) => {
    fileApi.seen.push(path);
    return fileApi.content;
  },
  executeCommand: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
}));

import { createMemoryGoalStore } from "../core/goal/store";
import type { GoalStore } from "../core/goal/store";
import { GoalRunner } from "../core/goal/runner";
import type { GoalTurnArgs, GoalTurnResult } from "../core/goal/runner";
import type { ReplanArgs, ReplanResult } from "../core/goal/planner";
import type { Acceptance, AcceptanceResult, GoalContract, GoalPlan, PlanPhase } from "../core/goal/types";
import { isReplanTrigger, REPLAN_TRIGGERS } from "../core/goal/types";

const SESSION = "s-goal-runner";

function contractAcceptance(): Acceptance {
  return { id: "A1", kind: "test", description: "整体回归为绿", command: "npm test" };
}

function phase(key: string, order: number, dependsOn: string[], outcome?: string): PlanPhase {
  return {
    key,
    order,
    title: `阶段${key}`,
    outcome: outcome ?? `${key} 的交付物已经可用并且可被验证`,
    acceptance: [{ id: `${key}.a1`, kind: "test", description: `${key} 验收`, command: "npm test" }],
    covers: ["A1"],
    dependsOn,
    risks: [],
    status: "pending",
    attempts: 0,
  };
}

function plan(goalId: string, phases?: PlanPhase[], version = 1): GoalPlan {
  return {
    goalId,
    version,
    contractVersion: 1,
    strategy: "先做数据层，再做端到端，最后做兼容性确认",
    invariants: ["不破坏既有行为"],
    phases: phases ?? [phase("p1", 0, []), phase("p2", 1, ["p1"]), phase("p3", 2, ["p2"])],
    createdAt: 1,
  };
}

function seed(
  store: GoalStore,
  opts: {
    goalPatch?: Partial<GoalContract>;
    planPatch?: Partial<GoalPlan>;
    phases?: PlanPhase[];
    goalId?: string;
  } = {},
): { goal: GoalContract; plan: GoalPlan } {
  const goal = store.createGoal({
    sessionId: SESSION,
    statement: "把导出链路做对，并有回归测试证明它不再丢字段",
    principles: ["不破坏既有行为"],
    nonGoals: ["不改 UI 文案"],
    acceptance: [contractAcceptance()],
    constraints: [],
    ...(opts.goalPatch?.budget ? { budget: opts.goalPatch.budget } : {}),
    ...(opts.goalPatch?.maxReplans !== undefined ? { maxReplans: opts.goalPatch.maxReplans } : {}),
  }, { id: opts.goalId ?? "goal-test", now: 1 });
  if (opts.goalPatch) {
    const { budget, maxReplans, ...rest } = opts.goalPatch;
    void budget;
    void maxReplans;
    store.replaceContract({ ...goal, ...rest });
  }
  const p = { ...plan(goal.id, opts.phases), ...opts.planPatch };
  store.savePlan(p);
  return { goal: store.getGoal(goal.id)!, plan: store.getActivePlan(goal.id)! };
}

/** 可编排的验收：按 acceptance id 排队；队列耗尽后默认通过 */
function acceptanceRunner(script: Record<string, boolean[]> = {}) {
  const calls: AcceptanceResult[] = [];
  const run = async (acceptance: Acceptance): Promise<AcceptanceResult> => {
    const queue = script[acceptance.id] ?? [];
    const passed = queue.length > 0 ? queue.shift()! : true;
    const result: AcceptanceResult = {
      acceptance,
      passed,
      summary: passed ? `${acceptance.id} 通过` : `${acceptance.id} 失败：期望 0 实际 1`,
      detail: passed ? "" : "stderr: boom",
      durationMs: 1,
    };
    calls.push(result);
    return result;
  };
  return { run, calls };
}

/** 可编排的回合：记录每次的 messageId/prompt；返回给定的 toolCallCount */
function turnRunner(script: Array<Partial<GoalTurnResult>> = []) {
  const turns: GoalTurnArgs[] = [];
  const run = async (args: GoalTurnArgs): Promise<GoalTurnResult> => {
    turns.push(args);
    const step = script.shift();
    return {
      output: "本轮结束",
      toolCallCount: 1,
      success: true,
      ...step,
    };
  };
  return { run, turns };
}

function runner(store: GoalStore, deps: Partial<ConstructorParameters<typeof GoalRunner>[0]> = {}) {
  return new GoalRunner({
    store,
    runTurn: async () => ({ output: "ok", toolCallCount: 1, success: true }),
    runAcceptance: async (a) => ({ acceptance: a, passed: true, summary: "ok", durationMs: 1 }),
    maxAttemptsPerPhase: 3,
    noProgressLimit: 3,
    ...deps,
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("GOAL-4 阶段门禁以证据为准（模型自述不算）", () => {
  it("模型每轮都说成功，但验收一直不过 ⇒ 阶段不 done，最终 blocked（原因可见）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const acceptance = acceptanceRunner({ "p1.a1": [false, false, false] });
    const turns = turnRunner([{ toolCallCount: 3, success: true }, { toolCallCount: 2 }, { toolCallCount: 1 }]);
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptance.run });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "三次验收都没过 ⇒ 不能声称完成").toBe("blocked");
    expect(store.listPhases(goal.id, 1)[0].status).not.toBe("done");
    const evidence = store.listEvidence(goal.id, { phaseKey: "p1" });
    expect(evidence.length).toBeGreaterThanOrEqual(3);
    expect(evidence.every((e) => !e.passed), "证据必须如实记录失败").toBe(true);
    expect(store.getGoal(goal.id)?.status).toBe("blocked");
  });
});

describe("GOAL-5 阶段完成自动进入下一阶段（无需用户点击）", () => {
  it("三个阶段依次通过 ⇒ 目标 completed，回合数 = 3", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner();
    const acceptance = acceptanceRunner();
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptance.run });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("completed");
    expect(turns.turns.length, "一个阶段一个回合；没有额外等待用户").toBe(3);
    expect(store.listPhases(goal.id, 1).map((p) => p.status)).toEqual(["done", "done", "done"]);
    expect(store.getGoal(goal.id)?.status).toBe("completed");
  });
});

describe("GOAL-6 / GOAL-16 阶段内无 tool call + 验收未达 ⇒ 自动继续", () => {
  it("第一次回合没有 tool call 且验收失败 ⇒ 自动发起第二次回合（同阶段），并留 auto_continue 决策", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner([{ toolCallCount: 0 }, { toolCallCount: 2 }]);
    const acceptance = acceptanceRunner({ "p1.a1": [false, true] });
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptance.run });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("completed");
    expect(turns.turns.length, "无 tool call 不许就此收工").toBe(4); // p1×2 + p2 + p3
    // 阶段指令的 id 可辨认（A1：UI 按它渲染成系统说明），且第二次仍是同一阶段
    expect(turns.turns[0].messageId).toContain("goal-phase-");
    expect(turns.turns[0].messageId).toContain("-p1-1");
    expect(turns.turns[1].messageId).toContain("-p1-2");
    // 权威日志：autocontinue 决策
    const autoContinues = store.listDecisions(goal.id).filter((d) => d.kind === "auto_continue");
    expect(autoContinues).toHaveLength(1);
    expect(autoContinues[0].reason).toContain("自动继续");
  });

  it("反向对照：验收已达成时**不**自动继续（不多发回合）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner([{ toolCallCount: 0 }]);
    const r = runner(store, { runTurn: turns.run }); // 验收默认全通过

    await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(turns.turns.length, "验收通过就没有继续的理由").toBe(3);
    expect(store.listDecisions(goal.id).some((d) => d.kind === "auto_continue")).toBe(false);
  });
});

describe("GOAL-7 连续 3 次无进展 ⇒ 停止空转（重规划或阻塞）", () => {
  it("三次验收指纹相同 ⇒ 触发重规划（trigger=phase_failed，原因含无进展）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner();
    const acceptance = acceptanceRunner({ "p1.a1": [false, false, false] });
    const replan = vi.fn(
      async (_args: ReplanArgs): Promise<ReplanResult> => ({
        kind: "failed",
        reason: "（判据里故意失败）",
        violations: [],
      }),
    );
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptance.run, replan });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("blocked");
    expect(replan).toHaveBeenCalledTimes(1);
    const args = replan.mock.calls[0][0] as ReplanArgs;
    expect(args.trigger).toBe("phase_failed");
    expect(args.evidence.length, "重规划必须带证据").toBeGreaterThan(0);
    expect(args.failedPhaseKey).toBe("p1");
  });
});

describe("GOAL-11 预算：unlimited 不因 token/时间/轮数停止；capped 达限暂停", () => {
  it("unlimited：超大输出/多回合也照常跑到完成", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const big = "x".repeat(200_000);
    const turns = turnRunner([{ output: big }, { output: big }, { output: big }]);
    const r = runner(store, { runTurn: turns.run });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("completed");
    const usage = store.getGoal(goal.id)!.usage;
    expect(usage.turns).toBe(3);
    expect(usage.tokens, "usage 只是显示口径，不参与 unlimited 的停止").toBeGreaterThan(100_000);
  });

  it("capped(maxTurns=1)：第一回合后暂停（不是失败），原因可见", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, { goalPatch: { budget: { mode: "capped", maxTurns: 1 } } });
    const turns = turnRunner();
    const r = runner(store, { runTurn: turns.run });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("paused");
    if (outcome.kind === "paused") expect(outcome.reason).toContain("预算");
    expect(store.getGoal(goal.id)?.status).toBe("paused");
    expect(turns.turns.length).toBe(1);
    expect(store.listDecisions(goal.id).some((d) => d.kind === "budget_capped")).toBe(true);
  });
});

describe("GOAL-13 审批暂停 / 批准后自动继续 / 拒绝则阻塞", () => {
  it("批准：阶段回合在审批点挂起，批准后自动继续到完成（不需要再点继续）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner();
    let pendingResolve: ((value: { requestId: string; action: "allow" | "deny"; note?: string }) => void) | null = null;

    const runTurn = async (args: GoalTurnArgs): Promise<GoalTurnResult> => {
      if (turns.turns.length === 0) {
        const pending = args.onPermissionRequest?.({ id: "perm-1", title: "bash" } as never);
        expect(pending, "Runner 必须把审批回调透传给阶段回合").toBeTruthy();
        expect(pendingResolve, "审批请求应已挂起").toBeTruthy();
        pendingResolve!({ requestId: "perm-1", action: "allow" });
        const answer = await pending!;
        expect(answer.action).toBe("allow");
      }
      return turns.run(args);
    };
    const r = runner(store, { runTurn });

    const runPromise = r.run({
      goalId: goal.id,
      cwd: "C:\\repo",
      signal: signal(),
      onPermissionRequest: ((request: { id: string }) =>
        new Promise((resolve) => {
          pendingResolve = (v) => resolve({ ...v, requestId: request.id });
        })) as never,
    });
    // 等一个宏任务让审批挂起
    await new Promise((r2) => setTimeout(r2, 0));
    expect(pendingResolve, "未批准的阶段必须停在审批点（而不是自动放行）").toBeTruthy();
    const outcome = await runPromise;
    expect(outcome.kind).toBe("completed");
    expect(turns.turns.length).toBe(3);
  });

  it("拒绝：验收不过 ⇒ 三次尝试后阻塞（不会把拒绝当批准）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner();
    const acceptance = acceptanceRunner({ "p1.a1": [false, false, false] });
    const r = runner(store, {
      runTurn: async (args) => {
        const answer = await args.onPermissionRequest?.({ id: "perm-deny", title: "bash" } as never);
        expect(answer?.action).toBe("deny");
        return turns.run(args);
      },
      runAcceptance: acceptance.run,
    });
    const outcome = await r.run({
      goalId: goal.id,
      cwd: "C:\\repo",
      signal: signal(),
      onPermissionRequest: (async () => ({ requestId: "perm-deny", action: "deny", reason: "no" })) as never,
    });
    expect(outcome.kind).toBe("blocked");
  });
});

describe("GOAL-14 用户停止：立刻暂停，不再开新阶段", () => {
  it("第一回合中 abort ⇒ paused，且没有第二个阶段的回合", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const controller = new AbortController();
    const turns = turnRunner();
    const r = runner(store, {
      runTurn: async (args) => {
        controller.abort();
        return turns.run(args);
      },
    });
    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: controller.signal });
    expect(outcome.kind).toBe("paused");
    expect(turns.turns.length).toBe(1);
    expect(store.getGoal(goal.id)?.status).toBe("paused");
  });
});

describe("GOAL-10 重启恢复：已完成阶段不重跑", () => {
  it("p1 已 done、p2 active ⇒ 新 Runner 只跑 p2/p3", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    store.updatePhase(goal.id, 1, "p1", { status: "done", attempts: 1, completedAt: 500 });
    store.updatePhase(goal.id, 1, "p2", { status: "active", attempts: 1, startedAt: 600 });
    store.addEvidence({
      id: "ev-p1",
      goalId: goal.id,
      planVersion: 1,
      phaseKey: "p1",
      attempt: 1,
      kind: "test",
      acceptanceId: "p1.a1",
      summary: "p1 通过",
      passed: true,
      createdAt: 500,
    });

    const turns = turnRunner();
    const r = runner(store, { runTurn: turns.run });
    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("completed");
    expect(turns.turns.length, "p1 已完成：两轮（p2 + p3），不许重跑 p1").toBe(2);
    expect(turns.turns[0].messageId).toContain("-p2-");
    expect(turns.turns[1].messageId).toContain("-p3-");
  });
});

describe("GOAL-8 重规划：白名单 + 版本化 + 保留已完成阶段", () => {
  it("p1 通过、p2 失败三次 ⇒ v2 计划里 p1 原样保留（done），新阶段从 q1 起，revision 有证据", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    const turns = turnRunner();
    const acceptance = acceptanceRunner({
      "p2.a1": [false, false, false],
      "q1.a1": [true],
      "q2.a1": [true],
    });
    const replan = vi.fn(async (args: ReplanArgs): Promise<ReplanResult> => {
      const remaining = [phase("x1", 0, []), phase("x2", 1, ["x1"])];
      return {
        kind: "plan",
        plan: {
          goalId: args.plan.goalId,
          version: args.plan.version + 1,
          contractVersion: 1,
          strategy: "换一条实现路径，先补协议层再补 UI",
          invariants: ["不破坏既有行为"],
          phases: remaining,
          createdAt: 1001,
        },
      };
    });
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptance.run, replan });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(outcome.kind, "重规划后半途继续应能完成").toBe("completed");

    const plan2 = store.getActivePlan(goal.id)!;
    expect(plan2.version).toBe(2);
    const p1 = plan2.phases.find((p) => p.key === "p1")!;
    expect(p1.status, "已完成阶段必须原样保留").toBe("done");
    expect(p1.outcome).toBe("p1 的交付物已经可用并且可被验证");
    expect(plan2.phases.some((p) => p.key === "q1"), "新阶段重新编号，避开旧 key 空间").toBe(true);
    expect(plan2.revision?.trigger).toBe("phase_failed");
    expect(plan2.revision?.evidenceIds.length).toBeGreaterThan(0);
    expect(store.listDecisions(goal.id).some((d) => d.kind === "plan_replanned")).toBe(true);
  });

  it("重规划白名单之外的值不构成触发条件（防‘想到新点子就重写计划’）", () => {
    expect(REPLAN_TRIGGERS).toEqual([
      "evidence_refutes",
      "acceptance_unreachable",
      "invariant_conflict",
      "phase_failed",
      "user_changed_goal",
    ]);
    expect(isReplanTrigger("new_idea")).toBe(false);
    expect(isReplanTrigger("phase_failed")).toBe(true);
  });

  it("重规划次数达上限 ⇒ 阻塞（不无限重写）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, { goalPatch: { maxReplans: 1 } });
    store.updateGoal(goal.id, { replanCount: 1 });
    const turns = turnRunner();
    const acceptance = acceptanceRunner({ "p1.a1": [false, false, false] });
    const replan = vi.fn();
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptance.run, replan });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(outcome.kind).toBe("blocked");
    expect(replan).not.toHaveBeenCalled();
    expect(store.getGoal(goal.id)?.blockedReason).toContain("上限");
  });
});

describe("GOAL-9 契约变更 ⇒ 下一次运行先重规划（用户改意图）", () => {
  it("goal.version(2) > plan.contractVersion(1) ⇒ 以 user_changed_goal 触发重规划", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store);
    store.replaceContract({ ...store.getGoal(goal.id)!, version: 2, statement: "改成不导出，改为只读校验" });
    const turns = turnRunner();
    const replan = vi.fn(async (args: ReplanArgs): Promise<ReplanResult> => ({
      kind: "plan",
      plan: {
        goalId: args.plan.goalId,
        version: 2,
        contractVersion: 2,
        strategy: "按新意图重排",
        invariants: ["不破坏既有行为"],
        phases: [phase("x1", 0, []), phase("x2", 1, ["x1"]), phase("x3", 2, ["x2"])],
        createdAt: 1002,
      },
    }));
    const r = runner(store, { runTurn: turns.run, replan });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(outcome.kind).toBe("completed");
    const args = replan.mock.calls[0][0] as ReplanArgs;
    expect(args.trigger).toBe("user_changed_goal");
    expect(store.getActivePlan(goal.id)!.contractVersion).toBe(2);
  });
});

describe("GOAL-19 工件验收：相对路径按阶段工作目录解析（G5 真机教训）", () => {
  it("artifact path=test/sum.test.js ⇒ 实际读 C:\\repo\\test/sum.test.js", async () => {
    const store = createMemoryGoalStore(() => 1);
    const goal = store.createGoal(
      {
        sessionId: "s-artifact",
        statement: "工件路径解析",
        principles: [],
        nonGoals: [],
        acceptance: [contractAcceptance()],
        constraints: [],
      },
      { id: "goal-artifact" },
    );
    const p = phase("p1", 0, []);
    p.acceptance = [
      { id: "p1.a1", kind: "artifact", description: "测试文件存在边界用例", path: "test/sum.test.js", contains: "[]" },
    ];
    store.savePlan(plan(goal.id, [p]));

    fileApi.seen.length = 0;
    const r = runner(store, {
      runTurn: async () => ({ output: "ok", toolCallCount: 1, success: true }),
      runAcceptance: undefined, // 走生产默认验收（被上面的 file-api 替身接住）
    });
    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(outcome.kind).toBe("completed");
    expect(fileApi.seen[0], "相对路径必须接到阶段 cwd 上，而不是应用进程目录").toMatch(/^C:[\\/]repo[\\/]test[\\/]sum\.test\.js$/);
  });

  it("反向对照：绝对路径原样使用（不被拼接）", async () => {
    const store = createMemoryGoalStore(() => 1);
    const goal = store.createGoal(
      {
        sessionId: "s-artifact-abs",
        statement: "绝对路径",
        principles: [],
        nonGoals: [],
        acceptance: [contractAcceptance()],
        constraints: [],
      },
      { id: "goal-artifact-abs" },
    );
    const p = phase("p1", 0, []);
    p.acceptance = [{ id: "p1.a1", kind: "artifact", description: "绝对路径", path: "D:\\work\\x.txt", contains: "x" }];
    store.savePlan(plan(goal.id, [p]));

    fileApi.seen.length = 0;
    const r = runner(store, {
      runTurn: async () => ({ output: "ok", toolCallCount: 1, success: true }),
      runAcceptance: undefined,
    });
    await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(fileApi.seen[0]).toBe("D:\\work\\x.txt");
  });
});
