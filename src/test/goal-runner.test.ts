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
import { recordDocumentOutline } from "../core/document/ledger";
import {
  __resetDocumentBackendForTests,
  __resetDocumentLedgerForTests,
  setDocumentBackend,
} from "../core/document/test-seams";
import { createFakeDocumentBackend, makeDoc } from "./helpers/documents-fake";

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

// ========== C10 × C06：里程碑完成前的独立检查（Verifier 钩子） ==========

describe("C10×C06 里程碑完成前独立检查（默认接真实文档同步）", () => {
  /**
   * 判据（先写判据，再改实现）：
   *
   * | 判据 | 钉什么 | 变异（去掉完成前检查 ⇒） |
   * |---|---|---|
   * | GOAL-DOC-1 | 里程碑引用的文档落后 ⇒ 阶段**不标 done**、目标 blocked、reason 可见 | 不跑检查 ⇒ 阶段 done、目标 completed ⇒ 红 |
   * | GOAL-DOC-2 | 文档同步（检查通过）⇒ 阶段 done、目标 completed，决策里落检查结果 | 无条件拦 ⇒ 红 |
   * | GOAL-DOC-3 | 没有文档引用 ⇒ **不阻塞**，决策如实标注「独立检查未接入」 | 无引用也拦 ⇒ 红 |
   * | GOAL-DOC-4 | 默认实现接的是**真实 C06**：账本版本 vs 当前文档版本（不是只看注入值） | 检查永远返回 ok ⇒ 第一条红 |
   */
  beforeEach(() => {
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });
  afterEach(() => {
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });

  /** 一个引用了文档工件的里程碑（artifact path 以文档扩展名结尾） */
  function docPhase(key: string, docPath: string): PlanPhase {
    const p = phase(key, 0, []);
    p.acceptance = [
      { id: `${key}.a1`, kind: "artifact", description: `文档 ${docPath} 存在`, path: docPath, contains: "x" },
    ];
    return p;
  }

  /** 账本记下「读它那一刻」的版本（当前版本由假后端决定） */
  function seedLedgerDoc(collectionId: string, documentId: string, name: string, recordedAt: number): void {
    recordDocumentOutline({ collectionId, documentId, documentName: name, headings: ["第一章"], updatedAt: recordedAt });
  }

  function setDocVersion(documentId: string, name: string, currentAt: number): void {
    setDocumentBackend(createFakeDocumentBackend({ documents: [makeDoc({ id: documentId, name, updated_at: currentAt })] }).backend);
  }

  it("GOAL-DOC-1: 文档落后 ⇒ 阶段不标完成、目标 blocked 且 reason 可见（注入检查）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, { phases: [docPhase("p1", "设计.md"), phase("p2", 1, ["p1"])] });
    const preCompletionCheck = vi.fn(async () => ({
      checked: true,
      ok: false,
      reason: "C06 文档版本未同步（读过之后变了：设计.md）",
    }));
    const turns = turnRunner();
    const r = runner(store, {
      runTurn: turns.run,
      runAcceptance: acceptanceRunner().run,
      preCompletionCheck,
    });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "检查未通过不许标完成").toBe("blocked");
    expect(outcome.kind === "blocked" ? outcome.reason : "").toContain("设计.md");
    expect(preCompletionCheck, "每个里程碑完成前都要过独立检查").toHaveBeenCalledTimes(1);
    const phases = store.listPhases(goal.id, 1);
    expect(phases[0].status, "本阶段不许标 done").not.toBe("done");
    expect(phases[1].status, "后续阶段不许被推进").toBe("pending");
    expect(store.getGoal(goal.id)?.status).toBe("blocked");
    expect(store.getGoal(goal.id)?.blockedReason).toContain("设计.md");
    const failed = store.listDecisions(goal.id).filter((d) => d.kind === "phase_failed");
    expect(failed[failed.length - 1]?.reason, "决策日志里要能看见独立检查").toContain("独立检查");
  });

  it("GOAL-DOC-2: 文档同步（检查通过）⇒ 阶段完成、目标 completed，并落检查结果", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, { phases: [docPhase("p1", "设计.md")] });
    const preCompletionCheck = vi.fn(async () => ({
      checked: true,
      ok: true,
      reason: "C06 已检查 1 份带版本文档，里程碑引用的文档版本未变化",
    }));
    const r = runner(store, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
      preCompletionCheck,
    });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind).toBe("completed");
    expect(store.listPhases(goal.id, 1)[0].status).toBe("done");
    const passed = store.listDecisions(goal.id).filter((d) => d.kind === "phase_passed");
    expect(passed, "阶段通过要留决策").toHaveLength(1);
    const payload = passed[0].payload as { docSync?: { checked?: boolean; ok?: boolean } };
    expect(payload.docSync?.checked, "决策里要落检查结果").toBe(true);
    expect(payload.docSync?.ok).toBe(true);
  });

  it("GOAL-DOC-3: 没有文档引用 ⇒ 默认检查不阻塞，并如实标注「未接入」", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store); // 默认三个里程碑：验收全是命令，没有文档引用
    const r = runner(store, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
    });

    const outcome = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "没有可比对的文档版本 ⇒ 不阻塞").toBe("completed");
    const passed = store.listDecisions(goal.id).filter((d) => d.kind === "phase_passed");
    expect(passed).toHaveLength(3);
    const payload = passed[0].payload as { docSync?: { checked?: boolean; ok?: boolean } };
    expect(payload.docSync?.checked, "没接入就是没接入（不假装检查过）").toBe(false);
    expect(payload.docSync?.ok).toBe(true);
    expect(passed[0].reason).toContain("未接入");
  });

  it("GOAL-DOC-4: 默认实现接真实 C06 —— 文档版本落后 ⇒ blocked；已同步 ⇒ completed", async () => {
    const collectionId = `session:${SESSION}`;

    // ① 账本记的是 100，文档现在是 200 ⇒ 版本落后
    const staleStore = createMemoryGoalStore(() => 1000);
    const stale = seed(staleStore, { phases: [docPhase("p1", "设计.md")] });
    seedLedgerDoc(collectionId, "doc_1", "设计.md", 100);
    setDocVersion("doc_1", "设计.md", 200);
    const staleOutcome = await runner(staleStore, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
    }).run({ goalId: stale.goal.id, cwd: "C:\\repo", signal: signal() });

    expect(staleOutcome.kind, "真实 C06 检查必须拦住落后的文档").toBe("blocked");
    expect(staleOutcome.kind === "blocked" ? staleOutcome.reason : "").toContain("设计.md");
    expect(staleStore.listPhases(stale.goal.id, 1)[0].status).not.toBe("done");

    // ② 重新记成当前版本 ⇒ 已同步，正常完成
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
    const syncedStore = createMemoryGoalStore(() => 1000);
    const synced = seed(syncedStore, { phases: [docPhase("p1", "设计.md")] });
    seedLedgerDoc(collectionId, "doc_1", "设计.md", 200);
    setDocVersion("doc_1", "设计.md", 200);
    const syncedOutcome = await runner(syncedStore, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
    }).run({ goalId: synced.goal.id, cwd: "C:\\repo", signal: signal() });

    expect(syncedOutcome.kind, "同步后必须能正常完成").toBe("completed");
    expect(syncedStore.listPhases(synced.goal.id, 1)[0].status).toBe("done");
  });
});

// ========== C06 × **目标级**验收：所有阶段 done 之后的完成前独立检查 ==========

describe("C06×目标级 最终完成前独立检查（goal.acceptance 接文档同步）", () => {
  /**
   * 判据（先写判据，再改实现）：
   *
   * | 判据 | 钉什么 | 变异（目标级跳过检查 ⇒） |
   * |---|---|---|
   * | GOAL-GOAL-DOC-1 | 目标验收引用的文档落后 ⇒ **不标 completed**、目标 blocked、reason 含「目标」与文档名 | 跳过目标级检查 ⇒ 目标 completed ⇒ 红 |
   * | GOAL-GOAL-DOC-2 | 同步之后 ⇒ completed；已完成阶段不重跑；完成决策落 docSync | 无条件拦 ⇒ 红 |
   * | GOAL-GOAL-DOC-3 | 目标验收没有文档引用 ⇒ **不阻塞**，完成决策标 `docSync.checked:false` | 无引用也拦 ⇒ 红 |
   * | GOAL-GOAL-DOC-4 | 检查器**抛错** ⇒ fail-closed（blocked，不是 completed） | 抛错当通过 ⇒ 红 |
   */
  beforeEach(() => {
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });
  afterEach(() => {
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
  });

  /** 目标级验收：一个以文档扩展名结尾的工件（step 1 的检查对象） */
  function docAcceptance(docPath: string): Acceptance {
    return { id: "A1", kind: "artifact", description: `文档 ${docPath} 已同步`, path: docPath, contains: "x" };
  }

  function seedLedgerDoc(collectionId: string, documentId: string, name: string, recordedAt: number): void {
    recordDocumentOutline({ collectionId, documentId, documentName: name, headings: ["第一章"], updatedAt: recordedAt });
  }

  function setDocVersion(documentId: string, name: string, currentAt: number): void {
    setDocumentBackend(createFakeDocumentBackend({ documents: [makeDoc({ id: documentId, name, updated_at: currentAt })] }).backend);
  }

  function goalCompletedPayload(store: GoalStore, goalId: string): { checked?: boolean; ok?: boolean } {
    const decisions = store.listDecisions(goalId).filter((d) => d.kind === "goal_completed");
    const payload = decisions[decisions.length - 1]?.payload as { docSync?: { checked?: boolean; ok?: boolean } } | undefined;
    return payload?.docSync ?? {};
  }

  it("GOAL-GOAL-DOC-1: 目标验收引用的文档落后 ⇒ 不标 completed、blocked，reason 含「目标」与文档名", async () => {
    const collectionId = `session:${SESSION}`;
    const store = createMemoryGoalStore(() => 1000);
    // 阶段验收不引用文档（阶段级 checked:false）—— 只有目标级验收引用，证明检查确实接在目标级
    const { goal } = seed(store, {
      goalPatch: { acceptance: [docAcceptance("交付说明.md")] },
      phases: [phase("p1", 0, [])],
    });
    seedLedgerDoc(collectionId, "doc_goal", "交付说明.md", 100);
    setDocVersion("doc_goal", "交付说明.md", 200);

    const outcome = await runner(store, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
    }).run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "目标级检查未通过不许标 completed").toBe("blocked");
    const reason = outcome.kind === "blocked" ? outcome.reason : "";
    expect(reason, "reason 必须点名这是目标级检查").toContain("目标");
    expect(reason, "reason 必须点名落后的文档").toContain("交付说明.md");
    expect(reason, "不能与里程碑级原因混同（阶段/目标要可区分）").not.toContain("里程碑完成前");
    expect(store.getGoal(goal.id)?.status).toBe("blocked");
    expect(store.getGoal(goal.id)?.blockedReason).toContain("交付说明.md");
    expect(store.listPhases(goal.id, 1)[0].status, "阶段已完成（卡在目标级）").toBe("done");
    expect(store.listDecisions(goal.id).filter((d) => d.kind === "goal_completed"), "绝不落「目标完成」").toHaveLength(0);
    const blocked = store.listDecisions(goal.id).filter((d) => d.kind === "goal_blocked");
    const payload = blocked[blocked.length - 1]?.payload as { docSync?: { checked?: boolean; ok?: boolean } };
    expect(payload.docSync?.checked, "落库的检查结果是「真的比对过」").toBe(true);
    expect(payload.docSync?.ok).toBe(false);
  });

  it("GOAL-GOAL-DOC-5: kind=file 的文档验收也参与（不再只认 artifact）", async () => {
    const collectionId = `session:${SESSION}`;
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, {
      goalPatch: { acceptance: [{ ...docAcceptance("交付说明.md"), kind: "file" }] },
      phases: [phase("p1", 0, [])],
    });
    seedLedgerDoc(collectionId, "doc_goal_file", "交付说明.md", 100);
    setDocVersion("doc_goal_file", "交付说明.md", 200);

    const outcome = await runner(store, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
    }).run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "kind=file 的文档落后也必须拦").toBe("blocked");
    expect(outcome.kind === "blocked" ? outcome.reason : "").toContain("交付说明.md");
  });

  it("GOAL-GOAL-DOC-2: 目标文档同步后 ⇒ completed；已完成阶段不重跑，完成决策落 docSync", async () => {
    const collectionId = `session:${SESSION}`;
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, {
      goalPatch: { acceptance: [docAcceptance("交付说明.md")] },
      phases: [phase("p1", 0, [])],
    });
    seedLedgerDoc(collectionId, "doc_goal", "交付说明.md", 100);
    setDocVersion("doc_goal", "交付说明.md", 200);

    const turns = turnRunner();
    const r = runner(store, { runTurn: turns.run, runAcceptance: acceptanceRunner().run });
    const first = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(first.kind, "文档落后 ⇒ 先 blocked").toBe("blocked");
    expect(turns.turns, "阶段跑过一次").toHaveLength(1);

    // 同步：账本重新记成**当前**版本；用户点「继续目标」把状态改回 active
    __resetDocumentLedgerForTests();
    __resetDocumentBackendForTests();
    seedLedgerDoc(collectionId, "doc_goal", "交付说明.md", 200);
    setDocVersion("doc_goal", "交付说明.md", 200);
    store.updateGoal(goal.id, { status: "active" });

    const second = await r.run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });
    expect(second.kind, "同步后必须能正常完成").toBe("completed");
    expect(store.getGoal(goal.id)?.status).toBe("completed");
    expect(turns.turns, "已完成阶段不重跑").toHaveLength(1);
    const payload = goalCompletedPayload(store, goal.id);
    expect(payload.checked, "完成决策要落「真的检查过」").toBe(true);
    expect(payload.ok).toBe(true);
    const completed = store.listDecisions(goal.id).filter((d) => d.kind === "goal_completed");
    expect(completed[0]?.reason).toContain("目标文档同步检查通过");
  });

  it("GOAL-GOAL-DOC-3: 目标验收没有文档引用 ⇒ 不阻塞，完成决策标注 docSync.checked:false", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store); // 默认目标/阶段验收都是命令，没有文档引用

    const outcome = await runner(store, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
    }).run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "没有可比对的文档版本 ⇒ 不阻塞").toBe("completed");
    expect(store.getGoal(goal.id)?.status).toBe("completed");
    const payload = goalCompletedPayload(store, goal.id);
    expect(payload.checked, "没接入就是没接入（不假装检查过）").toBe(false);
    expect(payload.ok).toBe(true);
    const completed = store.listDecisions(goal.id).filter((d) => d.kind === "goal_completed");
    expect(completed[0]?.reason).toContain("未接入");
  });

  it("GOAL-GOAL-DOC-4: 目标级检查器抛错 ⇒ fail-closed（blocked，不是 completed）", async () => {
    const store = createMemoryGoalStore(() => 1000);
    const { goal } = seed(store, { phases: [phase("p1", 0, [])] });
    const preGoalCompletionCheck = vi.fn(async () => {
      throw new Error("检查器坏了");
    });

    const outcome = await runner(store, {
      runTurn: turnRunner().run,
      runAcceptance: acceptanceRunner().run,
      preGoalCompletionCheck,
    }).run({ goalId: goal.id, cwd: "C:\\repo", signal: signal() });

    expect(outcome.kind, "无法证明同步 ⇒ 不许标完成").toBe("blocked");
    const reason = outcome.kind === "blocked" ? outcome.reason : "";
    expect(reason).toContain("目标完成前独立检查执行失败");
    expect(reason).toContain("检查器坏了");
    expect(preGoalCompletionCheck, "目标完成前必须真的调用检查器").toHaveBeenCalledTimes(1);
    expect(store.getGoal(goal.id)?.status).toBe("blocked");
    expect(store.listDecisions(goal.id).filter((d) => d.kind === "goal_completed")).toHaveLength(0);
  });
});
