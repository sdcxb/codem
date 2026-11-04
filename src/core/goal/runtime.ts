/**
 * 目标模式运行时（桌面接线层）—— App 只调这里的少数入口。
 *
 * 职责分界：
 * - `runner.ts`：调度/门禁/重规划，**不碰 UI、不碰会话消息以外的任何东西**；
 * - 本文件：把「用户发来一句话」变成「分类 → 规划 → 建契约 → 跑阶段」，并负责
 *   恢复/停止/改目标/完成报告/状态刷新；所有模型调用都在这里接到 `LLMEngine`。
 *
 * 关键约束（ADR-0006 §4）：
 * - 阶段执行**只走** `executeSessionTurn`（runner 默认实现），这里不另造循环；
 * - 不自动批准：审批回调原样透传（由 App 的权限对话框决定）；
 * - 规划失败/存储写不进去 ⇒ **回落普通执行并如实说明**，不把用户挡在门外、也不假装已建目标。
 */

import type { LLMEngine } from "../llm";
import type { LoopEvent } from "../llm/agentic-loop";
import type { PermissionRequest, PermissionResult } from "../permission/permission";
import * as MessageStorage from "../storage/message";
import { useAppStore } from "../../store";
import { isSessionOnScreen } from "../ui/loop-stream-state";
import { buildGoalView } from "./context";
import { emitGoalEvent, subscribeGoalEvents } from "./events";
import type { PlannerComplete } from "./planner";
import { planGoal } from "./planner";
import { getGoalStore } from "./store";
import type { GoalStore } from "./store";
import { GoalRunner } from "./runner";
import { getGoalBudgetSetting, getGoalResumeOnOpen, isGoalModeEnabled } from "./settings";
import { markGoalPlanning, refreshGoalView } from "./state";
import { domainEnsureLoaded } from "../storage/domain-store";
import type { GoalContract, GoalDecision, GoalEvidence, GoalPlan, GoalView, PlanPhase } from "./types";

/**
 * 等目标五张表的镜像就绪（最多 `timeoutMs`）。
 *
 * 为什么需要：建目标/存计划的**读回验证**是同步的。若表还在加载，`domainWrite` 会进延迟
 * 队列（返回"已接手"），随后的读回拿到空 ⇒ 明明写进去了却被判失败（G5 真机第一次就是这样）。
 * 预取清单已包含这五张表；这里再兜一层"启动窗口内建目标"的情况。
 */
async function ensureGoalTablesReady(timeoutMs = 2500): Promise<void> {
  const tables = ["goal_contracts", "goal_plans", "goal_phases", "goal_evidence", "goal_decisions"];
  await Promise.all(
    tables.map(
      (table) =>
        new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          try {
            domainEnsureLoaded(table, finish);
          } catch {
            finish();
          }
          setTimeout(finish, timeoutMs);
        }),
    ),
  );
}

// ========== 任务是否值得进入目标模式（便宜的预判，避免每条消息都多一次模型调用） ==========

/** 用户显式要求「按目标做」的标记 */
const FORCE_PATTERNS = [/按目标做/, /目标模式/, /里程碑/, /分阶段推进/, /long-horizon/i];
/** 用户显式要求「不要目标」的标记 */
const DISABLE_PATTERNS = [/不要目标/, /别拆目标/, /普通模式/, /单轮做/, /one-shot/i];
/** 多交付物/跨模块任务的信号（保守；宁可漏判走单轮自主，也不要把问答拆成微步） */
const MULTI_SIGNALS = [
  /\b1[.、)]\s*[\s\S]{2,40}?\b2[.、)]/, // 用户自己列了编号清单
  /首先[\s\S]{0,200}?然后[\s\S]{0,200}?最后/,
  /分[两三四五六七八九十]*步/,
  /(迁移|重构|端到端|全链路|前后端|跨模块|多个模块|多阶段|里程碑)/,
  /(实现|新增|补上)[\s\S]{0,40}?(并且|同时|以及)[\s\S]{0,60}?(实现|新增|补上|改)/,
  /\bstep\s*1\b[\s\S]{0,200}\bstep\s*2\b/i,
];
/** 明显的纯问答（不问就不规划） */
const QUESTION_PATTERNS = [/^(为什么|为什么\?|怎么|如何|什么是|解释|说明|讲讲|介绍|what|why|how|explain)/i];

/**
 * 预判：这句话**有可能**是多阶段任务吗？
 *
 * 为什么先预判再规划：规划要一次模型调用（几秒）。对"解释一下这个函数"这类消息
 * 花几秒去规划是纯粹的浪费。预判**只负责过滤明显不是的**，最终分类由规划器给
 * （它可能回 `single-phase`/`question`，我们照样回落普通执行）。
 */
export function looksMultiPhaseRequest(text: string): boolean {
  const value = (text ?? "").trim();
  if (value.length === 0) return false;
  if (DISABLE_PATTERNS.some((re) => re.test(value))) return false;
  if (FORCE_PATTERNS.some((re) => re.test(value))) return true;
  if (QUESTION_PATTERNS.some((re) => re.test(value)) && value.length < 300) return false;
  /**
   * 用户自己列了 3 条以上编号清单 ⇒ 这是**强信号**（比长度阈值可靠）：
   * 它已经是被用户拆好的交付物列表，不需要我们猜。
   */
  const numberedItems = (value.match(/(?:^|[\s：:；;，,])\d[.、)]/g) ?? []).length;
  if (numberedItems >= 3) return true;
  const multi = MULTI_SIGNALS.some((re) => re.test(value));
  if (!multi) return false;
  // 有信号才进入规划；短消息即使命中信号也再要一个长度下限，
  // 防「重构一下这个函数」被当成多阶段。
  return value.length >= 40 || FORCE_PATTERNS.some((re) => re.test(value));
}

// ========== 模型调用（规划/重规划） ==========

/**
 * 用引擎当前对话模型做一次**非流式、无工具**的补全。
 *
 * 为什么用 `chat` 槽位：深规划的质量直接决定整条目标的上限，用便宜的槽位省下的
 * 那点 token 会以「计划被推翻/粒度失衡」的形式在阶段里加倍还回来。
 * 解析失败不在这里兜底 —— 由规划器的重写循环处理（它会带着错误清单重问）。
 */
export function makeEngineCompleter(engine: LLMEngine): PlannerComplete {
  return async ({ system, user }) => {
    const slot = engine.resolveSlot("chat");
    const provider = engine.providers.get(slot.providerId);
    if (!provider || typeof provider.complete !== "function" || provider.isConfigured?.() === false) {
      throw new Error(`模型不可用（provider=${slot.providerId}, model=${slot.modelId}）`);
    }
    const response = await provider.complete({
      model: slot.modelId,
      messages: [
        { id: "goal-plan-system", role: "system", content: system },
        { id: "goal-plan-user", role: "user", content: user },
      ],
      temperature: 0,
      stream: false,
      // 12 个阶段 + 验收的 JSON 可能比较长；给足输出预算（不是"预算上限"，是单次调用长度）
      maxTokens: 8192,
    });
    return String(response?.content ?? "");
  };
}

// ========== 会话内公告（完成报告 / 阻塞原因 / 回落说明） ==========

function newMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 写一条系统说明消息；在屏时刷新列表（不在屏也会落库，切回可见） */
function announce(sessionId: string, content: string): void {
  try {
    MessageStorage.createMessage(
      {
        id: newMessageId("goal-report"),
        role: "system",
        content,
        timestamp: Date.now(),
        status: "done",
      },
      sessionId,
    );
    if (isSessionOnScreen(sessionId)) useAppStore.getState().loadMessages(sessionId);
  } catch (e) {
    console.warn("[Goal] 公告写入失败（不影响目标执行）:", e);
  }
}

function planSummary(goal: GoalContract, plan: GoalPlan): string {
  const lines = [
    `🧭 已进入长程目标模式（计划 v${plan.version}，${plan.phases.length} 个里程碑）`,
    `目标：${goal.statement}`,
  ];
  if (goal.nonGoals.length > 0) lines.push(`不做：${goal.nonGoals.join("；")}`);
  lines.push("");
  for (const p of plan.phases) {
    lines.push(`${p.order + 1}. ${p.title} —— ${p.outcome}`);
    for (const a of p.acceptance) lines.push(`   验收：${a.description}`);
  }
  lines.push("");
  lines.push(
    goal.budget.mode === "capped"
      ? `预算：capped（达到上限会暂停，可继续）`
      : `预算：不限（不因 token/时间/轮数停止）`,
  );
  lines.push("接下来会按阶段自动推进；只有审批/真正缺信息/目标阻塞/你停止时才会打断你。");
  return lines.join("\n");
}

function completionReport(store: GoalStore, goalId: string): string {
  const goal = store.getGoal(goalId);
  const plan = store.getActivePlan(goalId);
  if (!goal) return "目标已完成。";
  const evidence = store.listEvidence(goalId);
  const lines = [`✅ 目标完成：${goal.statement}`, ""];
  if (plan) {
    lines.push(`计划 v${plan.version}（${plan.phases.length} 个里程碑）：`);
    for (const p of plan.phases) {
      const ev = evidence.find((e) => e.phaseKey === p.key && e.passed);
      lines.push(`- [${p.status}] ${p.title}：${p.outcome}`);
      if (ev) lines.push(`    证据：${ev.summary}`);
    }
  }
  const goalEvidence = evidence.filter((e) => e.phaseKey === "goal");
  if (goalEvidence.length > 0) {
    lines.push("");
    lines.push("整体验收：");
    for (const e of goalEvidence) lines.push(`- [${e.passed ? "通过" : "未通过"}] ${e.acceptanceId}：${e.summary}`);
  }
  if (goal.replanCount > 0) lines.push(`\n期间重规划 ${goal.replanCount} 次（原因与证据在目标面板的「决策」里）。`);
  if (goal.nonGoals.length > 0) lines.push(`未做（按目标约定）：${goal.nonGoals.join("；")}`);
  const decisions = store.listDecisions(goalId, { limit: 200 });
  const riskNotes = decisions.filter((d) => d.kind === "plan_replanned").map((d) => d.reason);
  if (riskNotes.length > 0) lines.push(`\n期间的调整：\n${riskNotes.map((r) => `- ${r}`).join("\n")}`);
  return lines.join("\n");
}

function blockedReport(goalId: string, reason: string, store: GoalStore = getGoalStore()): string {
  const evidence = store.listEvidence(goalId, { limit: 6 }).filter((e) => !e.passed);
  const lines = [`⛔ 目标阻塞：${reason}`];
  if (evidence.length > 0) {
    lines.push("");
    lines.push("最近的失败证据：");
    for (const e of evidence.slice(-3)) lines.push(`- ${e.phaseKey}/${e.acceptanceId}：${e.summary}`);
  }
  lines.push("");
  lines.push("你可以：改目标（调整意图/验收）后继续；或直接告诉我换一条路。");
  return lines.join("\n");
}

// ========== 运行中的目标（同一时刻只允许一个） ==========

interface ActiveGoalRun {
  goalId: string;
  sessionId: string;
  controller: AbortController;
}

let activeRun: ActiveGoalRun | null = null;

export function getActiveGoalRun(): { goalId: string; sessionId: string } | null {
  return activeRun ? { goalId: activeRun.goalId, sessionId: activeRun.sessionId } : null;
}

/** 阶段回合内的增量刷新（在屏时 2 秒一次；executeSessionTurn 自己写库，界面要重读才看得到） */
function makePhaseObserver(sessionId: string): (event: LoopEvent) => void {
  let lastReload = 0;
  return () => {
    if (!isSessionOnScreen(sessionId)) return;
    const now = Date.now();
    if (now - lastReload < 2000) return;
    lastReload = now;
    try {
      useAppStore.getState().loadMessages(sessionId);
    } catch {
      /* 刷新失败不影响执行 */
    }
  };
}

/**
 * 启动（或恢复）一个已存在的目标。
 *
 * 返回的 Promise 在**整个目标跑完**之后才 resolve —— 调用方（`maybeStartGoalMode`）
 * **不要 await** 它（那会把用户的一次发送卡住几分钟）。这里用一个立即返回的包装。
 */
function launchGoalRun(args: {
  goalId: string;
  sessionId: string;
  cwd: string;
  engine: LLMEngine;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
  /** 判据注入（生产不传）：隔离 store / 假回合 / 假验收 */
  store?: GoalStore;
  complete?: PlannerComplete;
  runTurn?: (args: import("./runner").GoalTurnArgs) => Promise<import("./runner").GoalTurnResult>;
  runAcceptance?: (a: import("./types").Acceptance, ctx: { cwd: string }) => Promise<import("./types").AcceptanceResult>;
}): void {
  const { goalId, sessionId, cwd, engine, onPermissionRequest, store: injectedStore, complete, runTurn, runAcceptance } = args;
  if (activeRun) {
    if (activeRun.goalId === goalId) return;
    console.warn("[Goal] 已有目标在运行（单会话单 active goal）：", activeRun.goalId);
    return;
  }
  const store = injectedStore ?? getGoalStore();
  const controller = new AbortController();
  activeRun = { goalId, sessionId, controller };
  const runner = new GoalRunner({
    store,
    complete: complete ?? makeEngineCompleter(engine),
    ...(runTurn ? { runTurn } : {}),
    ...(runAcceptance ? { runAcceptance } : {}),
  });
  const observer = makePhaseObserver(sessionId);

  void runner
    .run({
      goalId,
      cwd,
      signal: controller.signal,
      engine,
      ...(onPermissionRequest ? { onPermissionRequest } : {}),
      onEvent: observer,
    })
    .then((outcome) => {
      if (outcome.kind === "completed") {
        announce(sessionId, completionReport(store, goalId));
      } else if (outcome.kind === "blocked") {
        announce(sessionId, blockedReport(goalId, outcome.reason, store));
      } else if (outcome.kind === "paused") {
        announce(sessionId, `⏸ 目标已暂停：${outcome.reason}\n（点「继续目标」会从当前阶段接着跑，已完成阶段不会重跑。）`);
      } else if (outcome.kind === "failed") {
        announce(sessionId, `⚠️ 目标执行失败：${outcome.reason}`);
      }
    })
    .catch((e) => {
      console.error("[Goal] run failed:", e);
      announce(sessionId, `⚠️ 目标执行异常：${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      if (activeRun?.goalId === goalId) activeRun = null;
      refreshGoalView(sessionId, store);
    });
}

export type StartGoalResult =
  | { handled: true; goalId: string }
  | {
      handled: false;
      reason: "disabled" | "not-candidate" | "single-phase" | "question" | "plan-failed" | "already-active" | "storage-failed" | "error";
      detail?: string;
    };

/**
 * 发送前调用：判断这次任务是否进入目标模式；进入则**已经启动**并在后台跑。
 *
 * 返回 `handled: false` 时调用方继续走原来的 `runAgenticLoop`（run 自主）。
 */
export async function maybeStartGoalMode(args: {
  sessionId: string;
  message: string;
  cwd: string;
  engine: LLMEngine;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
  /** 判据注入（生产不传）：隔离 store / 假模型调用 / 假回合 / 假验收 */
  store?: GoalStore;
  complete?: PlannerComplete;
  runTurn?: (args: import("./runner").GoalTurnArgs) => Promise<import("./runner").GoalTurnResult>;
  runAcceptance?: (a: import("./types").Acceptance, ctx: { cwd: string }) => Promise<import("./types").AcceptanceResult>;
}): Promise<StartGoalResult> {
  const { sessionId, message, cwd, engine, onPermissionRequest } = args;
  if (!isGoalModeEnabled()) return { handled: false, reason: "disabled" };
  const store = args.store ?? getGoalStore();
  const complete = args.complete ?? makeEngineCompleter(engine);
  const live = store.getLiveGoalForSession(sessionId);
  if (live) return { handled: false, reason: "already-active", detail: live.id };
  if (!looksMultiPhaseRequest(message)) return { handled: false, reason: "not-candidate" };

  // 表镜像就绪后再建目标：否则"写进去 + 立刻读回"会读到空（见函数注释）
  await ensureGoalTablesReady();

  markGoalPlanning(sessionId, true);
  emitGoalEvent({ type: "goal.planning", sessionId });
  try {
    const planned = await planGoal({
      sessionId,
      userMessage: message,
      cwd,
      deps: { complete },
      budget: getGoalBudgetSetting(),
    });

    if (planned.kind === "question" || planned.kind === "single-phase") {
      markGoalPlanning(sessionId, false);
      return { handled: false, reason: planned.kind, ...(planned.reason ? { detail: planned.reason } : {}) };
    }
    if (planned.kind === "failed") {
      markGoalPlanning(sessionId, false);
      announce(
        sessionId,
        `🧭 目标模式的深规划没有产出合格计划：${planned.reason}\n已按普通自主执行继续这次任务（不影响你这次要做的事）。`,
      );
      return { handled: false, reason: "plan-failed", detail: planned.reason };
    }

    // ---- 建契约 + 落库（两步都要读回来确认，否则就是"假持久化"）----
    let goal: GoalContract;
    try {
      goal = store.createGoal({
        sessionId,
        statement: planned.statement,
        principles: planned.principles,
        nonGoals: planned.nonGoals,
        acceptance: planned.acceptance,
        constraints: planned.constraints,
        budget: getGoalBudgetSetting(),
      });
    } catch (e) {
      markGoalPlanning(sessionId, false);
      announce(sessionId, `🧭 无法创建目标（${e instanceof Error ? e.message : String(e)}），已按普通自主执行。`);
      return { handled: false, reason: "storage-failed", detail: String(e) };
    }
    if (!store.getGoal(goal.id)) {
      markGoalPlanning(sessionId, false);
      announce(sessionId, "🧭 目标没有保存进库（存储端口未就绪），已按普通自主执行 —— 不会假装已进入目标模式。");
      return { handled: false, reason: "storage-failed" };
    }

    const plan: GoalPlan = {
      ...planned.plan,
      goalId: goal.id,
      contractVersion: goal.version,
    };
    store.savePlan(plan);
    const storedPlan = store.getActivePlan(goal.id);
    if (!storedPlan || storedPlan.phases.length !== plan.phases.length) {
      store.updateGoal(goal.id, { status: "cancelled", blockedReason: "计划未能保存" });
      markGoalPlanning(sessionId, false);
      announce(sessionId, "🧭 目标计划没有保存进库（存储端口未就绪），已按普通自主执行。");
      return { handled: false, reason: "storage-failed" };
    }

    const now = Date.now();
    store.addDecision({
      id: `gd-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId: goal.id,
      kind: "plan_created",
      reason: `深规划产出计划 v1（${plan.phases.length} 个阶段）`,
      planVersion: 1,
      createdAt: now,
    });
    markGoalPlanning(sessionId, false);
    announce(sessionId, planSummary(goal, plan));
    refreshGoalView(sessionId, store);
    emitGoalEvent({ type: "goal.created", sessionId, goalId: goal.id, planVersion: 1 });

    launchGoalRun({
      goalId: goal.id,
      sessionId,
      cwd,
      engine,
      store,
      complete,
      ...(args.runTurn ? { runTurn: args.runTurn } : {}),
      ...(args.runAcceptance ? { runAcceptance: args.runAcceptance } : {}),
      ...(onPermissionRequest ? { onPermissionRequest } : {}),
    });
    return { handled: true, goalId: goal.id };
  } catch (e) {
    markGoalPlanning(sessionId, false);
    console.warn("[Goal] maybeStartGoalMode failed:", e);
    announce(sessionId, `🧭 目标模式启动失败（${e instanceof Error ? e.message : String(e)}），已按普通自主执行。`);
    return { handled: false, reason: "error", detail: String(e) };
  }
}

// ========== 停止 / 继续 / 重启恢复 / 改目标 ==========

/**
 * 用户停止（GOAL-14）：**立刻**把目标置 paused（界面马上看到），再中止当前回合。
 *
 * 为什么先改状态再 abort：`executeSessionTurn` 的中止要等到下一个事件才生效
 * （工具在飞时可能更久）；界面如果等它就变成"点了没反应"。
 */
export function stopGoalRun(reason = "用户停止"): boolean {
  const store = getGoalStore();
  const run = activeRun;
  if (!run) return false;
  const goalId = run.goalId;
  const goal = store.getGoal(goalId);
  if (goal && goal.status === "active") {
    store.updateGoal(goalId, { status: "paused", blockedReason: reason });
    store.addDecision({
      id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId,
      kind: "goal_stopped",
      reason,
      createdAt: Date.now(),
    });
    emitGoalEvent({ type: "goal.status", sessionId: goal.sessionId, goalId, status: "paused", reason });
    refreshGoalView(goal.sessionId);
  }
  run.controller.abort();
  return true;
}

/**
 * 用户**取消**目标（结束，不保留可恢复状态）。
 *
 * 与「停止」的区别：停止 = paused（还能继续）；取消 = cancelled（状态条消失、不能再继续）。
 * 该入口会同时中止目标 controller 与会话当前回合（host.abortSession），
 * 解决"暂停后回合还在流式、界面挂住"的真机问题。
 */
export function cancelGoalRun(sessionId: string): { ok: boolean; reason?: string } {
  const store = getGoalStore();
  const goal =
    store.getLiveGoalForSession(sessionId) ?? store.getLatestGoalForSession(sessionId);
  if (!goal) return { ok: false, reason: "该会话没有目标" };
  if (goal.status === "completed" || goal.status === "cancelled") {
    return { ok: false, reason: "目标已结束" };
  }
  const run = activeRun;
  if (run && run.goalId === goal.id) {
    run.controller.abort();
  }
  store.updateGoal(goal.id, {
    status: "cancelled",
    blockedReason: "用户取消",
    completedAt: Date.now(),
  });
  store.addDecision({
    id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    goalId: goal.id,
    kind: "goal_cancelled",
    reason: "用户取消目标",
    createdAt: Date.now(),
  });
  emitGoalEvent({
    type: "goal.status",
    sessionId,
    goalId: goal.id,
    status: "cancelled",
    reason: "用户取消",
  });
  refreshGoalView(sessionId);
  return { ok: true };
}

/**
 * 继续一个 paused/blocked 的目标（用户点「继续目标」）。
 *
 * 语义边界：
 * - paused：直接接着跑（capped 的墙钟从这次继续重新计，否则会"一继续就再达限"）；
 * - blocked：只有当阻塞原因是可自行恢复的（用户改过目标 / 只是暂停）才继续；
 *   因重规划上限/无证据被拒的阻塞，继续会再次被挡住 —— 这是**有意**的（要么改目标，要么换路）。
 */
export function resumeGoalRun(args: {
  sessionId: string;
  cwd: string;
  engine: LLMEngine;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
}): { ok: boolean; reason?: string } {
  const store = getGoalStore();
  const goal = store.getLiveGoalForSession(args.sessionId) ?? store.getLatestGoalForSession(args.sessionId);
  if (!goal) return { ok: false, reason: "该会话没有目标" };
  if (goal.status === "completed" || goal.status === "cancelled") return { ok: false, reason: "目标已结束" };
  if (activeRun?.goalId === goal.id) return { ok: true };
  if (activeRun) return { ok: false, reason: "另一个目标正在运行" };

  store.updateGoal(goal.id, {
    status: "active",
    blockedReason: "",
    usage: { ...goal.usage, startedAt: Date.now() },
  });
  store.addDecision({
    id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    goalId: goal.id,
    kind: "goal_resumed",
    reason: "用户继续目标",
    createdAt: Date.now(),
  });
  emitGoalEvent({ type: "goal.status", sessionId: args.sessionId, goalId: goal.id, status: "active" });
  refreshGoalView(args.sessionId);
  launchGoalRun({
    goalId: goal.id,
    sessionId: args.sessionId,
    cwd: args.cwd,
    engine: args.engine,
    ...(args.onPermissionRequest ? { onPermissionRequest: args.onPermissionRequest } : {}),
  });
  return { ok: true };
}

/**
 * 打开会话时自动恢复（B2/GOAL-10：`resumeOnOpen` 默认开）。
 *
 * 只恢复 `active` 目标（= 上次被关闭/崩溃打断的那一个）；`paused` 是**用户主动暂停**，
 * 不自动续跑（那会变成"用户以为停了、它又自己跑起来"）。
 * 已完成阶段不重跑由 Runner 的阶段状态保证（只有 pending/active 会被挑中）。
 */
export function resumeGoalOnOpen(args: {
  sessionId: string;
  cwd: string;
  engine: LLMEngine;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
}): boolean {
  if (!getGoalResumeOnOpen()) return false;
  const store = getGoalStore();
  const goal = store.getLiveGoalForSession(args.sessionId);
  if (!goal || goal.status !== "active") {
    refreshGoalView(args.sessionId);
    return false;
  }
  if (activeRun) return false;
  store.addDecision({
    id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    goalId: goal.id,
    kind: "goal_resumed",
    reason: "打开会话时恢复未完成目标（重启/中断后继续，已完成阶段不重跑）",
    createdAt: Date.now(),
  });
  refreshGoalView(args.sessionId);
  launchGoalRun({
    goalId: goal.id,
    sessionId: args.sessionId,
    cwd: args.cwd,
    engine: args.engine,
    ...(args.onPermissionRequest ? { onPermissionRequest: args.onPermissionRequest } : {}),
  });
  return true;
}

/**
 * 改目标（GOAL-9：**必须由用户确认**）。
 *
 * 这里没有"模型自行修改"的入口：`changeGoalContract` 只从 UI 的用户动作调用。
 * 改动会 bump `version`；下一次 resume 时 Runner 发现 `plan.contractVersion < goal.version`
 * 会先重规划（`user_changed_goal`），不会拿旧计划的验收继续跑新意图。
 */
export function changeGoalContract(args: {
  sessionId: string;
  patch: Partial<Pick<GoalContract, "statement" | "principles" | "nonGoals" | "constraints">>;
  /** 判据注入（生产不传） */
  store?: GoalStore;
}): { ok: boolean; reason?: string } {
  const store = args.store ?? getGoalStore();
  const goal = store.getLiveGoalForSession(args.sessionId) ?? store.getLatestGoalForSession(args.sessionId);
  if (!goal) return { ok: false, reason: "该会话没有目标" };
  if (goal.status === "completed" || goal.status === "cancelled") return { ok: false, reason: "目标已结束" };
  if (activeRun?.goalId === goal.id) stopGoalRun("用户修改目标（先暂停）");

  const next: GoalContract = {
    ...goal,
    ...(args.patch.statement !== undefined && args.patch.statement.trim()
      ? { statement: args.patch.statement.trim() }
      : {}),
    ...(args.patch.principles !== undefined ? { principles: args.patch.principles } : {}),
    ...(args.patch.nonGoals !== undefined ? { nonGoals: args.patch.nonGoals } : {}),
    ...(args.patch.constraints !== undefined ? { constraints: args.patch.constraints } : {}),
    version: goal.version + 1,
    status: "paused",
    blockedReason: "目标契约已由用户修改，继续时会重新规划",
    updatedAt: Date.now(),
  };
  store.replaceContract(next);
  store.addDecision({
    id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    goalId: goal.id,
    kind: "contract_changed",
    reason: "用户修改了目标契约（意图变更，需要重规划）",
    planVersion: store.getActivePlan(goal.id)?.version,
    payload: { fromVersion: goal.version, toVersion: next.version },
    createdAt: Date.now(),
  });
  emitGoalEvent({ type: "goal.status", sessionId: args.sessionId, goalId: goal.id, status: "paused", reason: "contract_changed" });
  refreshGoalView(args.sessionId);
  return { ok: true };
}

// ========== 面板数据 ==========

export interface GoalDetails {
  view: GoalView;
  goal: GoalContract;
  plan: GoalPlan | null;
  phases: PlanPhase[];
  evidence: GoalEvidence[];
  decisions: GoalDecision[];
}

/** 目标面板要的全部数据（有界：证据/决策各最多 60 条） */
export function getGoalDetails(sessionId: string): GoalDetails | null {
  const store = getGoalStore();
  const goal = store.getLiveGoalForSession(sessionId) ?? store.getLatestGoalForSession(sessionId);
  if (!goal) return null;
  const view = buildGoalView(sessionId, { store });
  if (!view) return null;
  const plan = store.getActivePlan(goal.id);
  return {
    view,
    goal,
    plan,
    phases: plan?.phases ?? [],
    evidence: store.listEvidence(goal.id, { limit: 60 }),
    decisions: store.listDecisions(goal.id, { limit: 60 }),
  };
}

// ========== 运行宿主（App 注册；UI 组件不直接依赖 App 的 ref/state） ==========

/**
 * App 在启动时注册的宿主能力。
 *
 * 为什么不在 UI 组件里直接 import App：那会形成组件 → App 的反向依赖；
 * 而且"引擎实例 / 当前工作目录 / 审批弹窗"本来就只存在于 App 作用域。
 * 这里做成一个显式注册点（与 `getPet()` 同一种"运行期服务"形态），
 * 组件只调 `resumeSessionGoal` 这类语义入口。
 */
export interface GoalRuntimeHost {
  getEngine: () => LLMEngine | null;
  /** 该会话的工作目录（worktree 优先，其次项目根） */
  getCwd: (sessionId: string) => string;
  /** 把审批请求交给 App 的权限对话框（由用户决定） */
  onPermissionRequest: (sessionId: string, request: PermissionRequest) => Promise<PermissionResult>;
  /**
   * 中止该会话**当前回合**（App 的 abortControllers）。
   *
   * 为什么目标运行时要碰它：用户暂停目标后，回合可能仍在流式（尤其目标已经 paused、
   * `activeRun` 已清空时，只 abort 目标 controller 停不掉会话）。没有这个出口，
   * 界面会一直停在"正在运行"且目标条又只给「继续」——用户被卡死（真机 bug）。
   */
  abortSession?: (sessionId: string) => void;
}

let runtimeHost: GoalRuntimeHost | null = null;

export function registerGoalRuntimeHost(host: GoalRuntimeHost | null): void {
  runtimeHost = host;
}

/** 用户点「继续目标」（UI 入口；不需要传引擎/目录） */
export function resumeSessionGoal(sessionId: string): { ok: boolean; reason?: string } {
  const host = runtimeHost;
  const engine = host?.getEngine() ?? null;
  if (!host || !engine) return { ok: false, reason: "引擎尚未就绪" };
  const cwd = host.getCwd(sessionId);
  if (!cwd) return { ok: false, reason: "解析不到该会话的工作目录" };
  return resumeGoalRun({
    sessionId,
    cwd,
    engine,
    onPermissionRequest: (request) => host.onPermissionRequest(sessionId, request),
  });
}

/** 用户点「停止」/「暂停」（UI 入口） */
export function stopSessionGoal(sessionId: string): boolean {
  // 先中止**会话回合**：目标 controller 可能已经清空（paused/阶段间隙），
  // 只 abort 它会让流式回合继续跑，界面停在"正在运行"（真机 bug：暂停后挂住）。
  abortSessionTurn(sessionId);
  return stopGoalRun("用户停止");
}

/**
 * 用户点「取消目标」（UI 入口）：结束目标 + 中止会话当前回合。
 * 先 abort 会话回合再改状态：避免回合在状态变更后又写回一条消息（界面闪一下又挂住）。
 */
export function cancelSessionGoal(sessionId: string): { ok: boolean; reason?: string } {
  abortSessionTurn(sessionId);
  return cancelGoalRun(sessionId);
}

/** 只中止回合、不动目标（暂停/取消共用；回合不属于目标时也有效）。 */
export function abortSessionTurn(sessionId: string): void {
  try {
    runtimeHost?.abortSession?.(sessionId);
  } catch (e) {
    console.warn("[Goal] 中止会话回合失败:", e);
  }
}

// ========== 事件 → 视图刷新（一次接线，全局生效） ==========

let wired = false;
function wireGoalEvents(): void {
  if (wired) return;
  wired = true;
  subscribeGoalEvents((event) => {
    refreshGoalView(event.sessionId);
  });
}
wireGoalEvents();
