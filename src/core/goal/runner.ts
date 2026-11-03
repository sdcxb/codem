/**
 * Goal Runner —— **只调度，不实现第二个 agent 循环**。
 *
 * 设计依据 `GOAL-MODE-PLAN.md` §6–§8 与 `ADR-0006` §4。每个阶段都走现有
 * `executeSessionTurn`（工具/审批/存储/事件与普通回合完全一致），Runner 只做四件事：
 *
 * 1. **挑选下一个可执行阶段**（DAG：依赖全部 done）；
 * 2. **阶段循环**：执行 → 跑确定性验收 → 通过则标记 done 并自动进入下一阶段；
 *    不通过则带着**具体失败原因**重试（最多 3 次）；
 * 3. **无进展熔断**：连续 3 次验收指纹相同 ⇒ 不再空转（重规划或阻塞）；
 * 4. **受控重规划**：只允许白名单触发、必须带证据、版本化、已完成阶段原样保留。
 *
 * 预算默认 unlimited：**不因 token / 时间 / 轮数停止**（`estimateTurnTokens` 只用于显示与
 * capped 判定）。停止来源只有：目标完成 / 阻塞 / 审批 / 用户停止 / capped 达限 / 连续失败。
 *
 * 所有判据都可以通过 `deps` 注入假实现（`runTurn`、`runAcceptance`、`replan`），
 * 所以这个文件本身不需要真模型/真命令就能被完整测试。
 */

import type { LoopEvent } from "../llm/agentic-loop";
import type { LLMEngine } from "../llm";
import type { PermissionRequest, PermissionResult } from "../permission/permission";
import { buildPhasePrompt } from "./context";
import { emitGoalEvent } from "./events";
import { allAcceptancePassed, acceptanceFingerprint, summarizeFailure } from "./progress";
import { goalPhaseMessageId } from "../storage/session";
import type { PlannerComplete, ReplanArgs, ReplanResult } from "./planner";
import { planReplan } from "./planner";
import type { GoalStore } from "./store";
import { getGoalStore } from "./store";
import type {
  Acceptance,
  AcceptanceResult,
  GoalContract,
  GoalDecisionKind,
  GoalEvidence,
  GoalPlan,
  PlanPhase,
  PlanRevision,
  ReplanTrigger,
} from "./types";
import { isReplanTrigger } from "./types";

// ========== 依赖与入参 ==========

export interface GoalTurnArgs {
  sessionId: string;
  message: string;
  cwd: string;
  signal: AbortSignal;
  /** 注入消息的显式 id（`goal-phase-…`：UI 按它认「系统说明」，同 id 覆盖） */
  messageId?: string;
  engine?: LLMEngine;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
  onEvent?: (event: LoopEvent) => void;
}

export interface GoalTurnResult {
  output: string;
  toolCallCount: number;
  success: boolean;
  error?: string;
}

export interface GoalRunnerDeps {
  store: GoalStore;
  /** 阶段回合执行；默认走 `executeSessionTurn`（生产唯一路径） */
  runTurn?: (args: GoalTurnArgs) => Promise<GoalTurnResult>;
  /** 验收执行；默认：命令（exit code + 输出片段）/ 文件存在或包含 */
  runAcceptance?: (acceptance: Acceptance, ctx: { cwd: string }) => Promise<AcceptanceResult>;
  /** 重规划；默认走 `planner.planReplan`（需要 `complete`） */
  replan?: (args: ReplanArgs) => Promise<ReplanResult>;
  /** 规划/重规划用的模型调用（默认重规划需要） */
  complete?: PlannerComplete;
  now?: () => number;
  /** 阶段执行尝试上限（默认 3） */
  maxAttemptsPerPhase?: number;
  /** 连续无进展上限（默认 3） */
  noProgressLimit?: number;
  /** 重规划上限（默认取契约里的 maxReplans=5） */
  maxReplans?: number;
}

export interface RunGoalArgs {
  goalId: string;
  cwd: string;
  signal: AbortSignal;
  engine?: LLMEngine;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
  onEvent?: (event: LoopEvent) => void;
}

export type GoalRunOutcome =
  | { kind: "completed"; goalId: string }
  | { kind: "blocked"; goalId: string; reason: string }
  | { kind: "paused"; goalId: string; reason: string }
  | { kind: "failed"; goalId: string; reason: string }
  | { kind: "already-finished"; goalId: string; status: string };

type PhaseOutcome =
  | { kind: "passed" }
  | { kind: "stopped"; outcome: GoalRunOutcome }
  | { kind: "replanned" };

// ========== 默认实现 ==========

/**
 * 生产默认：复用现有后台回合执行器。
 *
 * ⚠️ 动态 import 有两个理由：① 让 Runner 的判据不必加载整个引擎/存储链；
 * ② 明确「这里没有第二套循环」—— 唯一的执行入口就是 `executeSessionTurn`。
 */
async function defaultRunTurn(args: GoalTurnArgs): Promise<GoalTurnResult> {
  const { executeSessionTurn } = await import("../session/executor");
  const result = await executeSessionTurn({
    sessionId: args.sessionId,
    message: args.message,
    cwd: args.cwd,
    engine: args.engine as LLMEngine,
    abortSignal: args.signal,
    ...(args.messageId ? { messageId: args.messageId } : {}),
    ...(args.onPermissionRequest ? { onPermissionRequest: args.onPermissionRequest } : {}),
    ...(args.onEvent ? { onEvent: args.onEvent } : {}),
  });
  return result;
}

/** 命令输出截断（喂回模型/落库都要有界） */
function truncateDetail(text: string, max = 4000): string {
  return text.length > max ? `…（前 ${max} 字符已省略）\n${text.slice(-max)}` : text;
}

/**
 * 生产默认验收。
 *
 * 「确定性」的具体含义：
 * - `command` / `test`：退出码等于 `expectExitCode`（默认 0），且（若给了）输出包含 `expectOutput`；
 * - `artifact`：文件可读，且（若给了）内容包含 `contains`。
 *
 * 失败时 `summary` 必须**具体**（退出码 + 输出尾部/缺哪个文件），否则重试时模型只能瞎猜。
 */
async function defaultRunAcceptance(acceptance: Acceptance, ctx: { cwd: string }): Promise<AcceptanceResult> {
  const started = Date.now();
  const base = { acceptance, durationMs: 0 };
  if (acceptance.kind === "command" || acceptance.kind === "test") {
    const command = acceptance.command ?? "";
    try {
      const { executeCommand } = await import("../file-api");
      const res = await executeCommand(command, ctx.cwd, acceptance.timeoutMs ?? 10 * 60 * 1000);
      const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
      const expectExit = acceptance.expectExitCode ?? 0;
      const exitOk = res.exitCode === expectExit;
      const outputOk = !acceptance.expectOutput || output.includes(acceptance.expectOutput);
      const passed = exitOk && outputOk;
      const summary = passed
        ? `命令通过（退出码 ${res.exitCode ?? "?"}，${Date.now() - started}ms）`
        : !exitOk
          ? `命令退出码 ${res.exitCode ?? "未知"}（期望 ${expectExit}）`
          : `命令输出不包含「${acceptance.expectOutput}」`;
      return {
        ...base,
        passed,
        summary,
        detail: truncateDetail(output || "(无输出)"),
        ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
        durationMs: Date.now() - started,
      };
    } catch (e) {
      return {
        ...base,
        passed: false,
        summary: `命令执行失败：${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - started,
      };
    }
  }
  // artifact
  const rawPath = (acceptance.path ?? "").trim();
  /**
   * 相对路径按**阶段工作目录**解析。
   *
   * 真机教训（G5）：`artifact: test/sum.test.js` 被原样交给 Tauri 的 readFile ⇒
   * 它按应用进程目录解析 ⇒ "系统找不到指定的路径"（文件明明在工作区里）。
   * 绝对路径（盘符/UNC/`/`）原样使用；其余一律接在 `ctx.cwd` 下。
   */
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\\\") || rawPath.startsWith("/");
  const resolvedPath = !rawPath
    ? ""
    : isAbsolute
      ? rawPath
      : `${ctx.cwd.replace(/[\\/]+$/, "")}/${rawPath.replace(/^\.?[\\/]/, "")}`;
  try {
    const { readFile } = await import("../file-api");
    if (!resolvedPath) throw new Error("artifact 验收缺少 path");
    const text = await readFile(resolvedPath);
    const ok = !acceptance.contains || text.includes(acceptance.contains);
    return {
      ...base,
      passed: ok,
      summary: ok ? `文件满足条件（${rawPath}）` : `文件 ${rawPath} 不包含「${acceptance.contains}」`,
      detail: truncateDetail(`文件 ${rawPath} 共 ${text.length} 字符`),
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ...base,
      passed: false,
      summary: `文件检查失败（${rawPath}）：${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - started,
    };
  }
}

/** 重规划默认实现（需要 `complete`；没有就明确失败而不是假装成功） */
function makeDefaultReplan(deps: GoalRunnerDeps) {
  return async (args: ReplanArgs): Promise<ReplanResult> => {
    if (!deps.complete) {
      return { kind: "failed", reason: "没有可用的模型调用（重规划需要 complete）", violations: [] };
    }
    return planReplan({ ...args, deps: { ...args.deps, complete: deps.complete } });
  };
}

// ========== Runner ==========

/** 归一化 outcome（重规划时判「新计划是否又排了已完成的工作」） */
function normOutcome(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000]+/g, "").replace(/[，。；：、,.!?;:'"「」『』()（）\-—_/\\]+/g, "");
}

/** 依赖是否都已完成 */
function depsSatisfied(phase: PlanPhase, byKey: Map<string, PlanPhase>): boolean {
  return phase.dependsOn.every((dep) => byKey.get(dep)?.status === "done");
}

/**
 * 阶段执行尝试的**无进展连击数**（GOAL-7）。
 *
 * 从已落库的证据里算（不是内存计数）：这样「重启后继续」也能看见「已经连续 3 次同样的失败」，
 * 不会因为进程重启把熔断计数清零。
 */
function noProgressStreak(store: GoalStore, goalId: string, phaseKey: string): number {
  const evidence = store.listEvidence(goalId, { phaseKey });
  const byAttempt = new Map<number, AcceptanceResult[]>();
  for (const e of evidence) {
    const list = byAttempt.get(e.attempt) ?? [];
    list.push({
      acceptance: { id: e.acceptanceId, kind: e.kind, description: e.summary },
      passed: e.passed,
      summary: e.summary,
      durationMs: 0,
    });
    byAttempt.set(e.attempt, list);
  }
  const attempts = [...byAttempt.keys()].sort((a, b) => a - b);
  let streak = 1;
  let prevFp: string | null = null;
  for (const attempt of attempts.reverse()) {
    const fp = acceptanceFingerprint(byAttempt.get(attempt) ?? []);
    if (prevFp === null) {
      prevFp = fp;
      continue;
    }
    if (fp !== prevFp) break;
    streak++;
  }
  return streak;
}

export class GoalRunner {
  private readonly store: GoalStore;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly noProgressLimit: number;

  constructor(private readonly deps: GoalRunnerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.maxAttempts = Math.max(1, deps.maxAttemptsPerPhase ?? 3);
    this.noProgressLimit = Math.max(2, deps.noProgressLimit ?? 3);
  }

  // ---------- 小工具 ----------

  private decision(
    goalId: string,
    kind: GoalDecisionKind,
    reason: string,
    extra: { planVersion?: number; phaseKey?: string; payload?: Record<string, unknown> } = {},
  ): void {
    this.store.addDecision({
      id: `gd-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId,
      kind,
      reason,
      ...(extra.planVersion !== undefined ? { planVersion: extra.planVersion } : {}),
      ...(extra.phaseKey ? { phaseKey: extra.phaseKey } : {}),
      ...(extra.payload ? { payload: extra.payload } : {}),
      createdAt: this.now(),
    });
  }

  private evidence(
    goalId: string,
    planVersion: number,
    phaseKey: string,
    attempt: number,
    result: AcceptanceResult,
  ): GoalEvidence {
    return {
      id: `gev-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId,
      planVersion,
      phaseKey,
      attempt,
      kind: result.acceptance.kind,
      acceptanceId: result.acceptance.id,
      summary: result.summary,
      ...(result.detail ? { detail: truncateDetail(result.detail) } : {}),
      passed: result.passed,
      createdAt: this.now(),
    };
  }

  /** 目标级验收（整体完成判定） */
  private async verifyGoalAcceptance(
    goal: GoalContract,
    cwd: string,
    plan: GoalPlan,
  ): Promise<{ ok: boolean; results: AcceptanceResult[]; evidenceIds: string[] }> {
    const runAcceptance = this.deps.runAcceptance ?? defaultRunAcceptance;
    const results: AcceptanceResult[] = [];
    const evidenceIds: string[] = [];
    for (const acceptance of goal.acceptance) {
      const result = await runAcceptance(acceptance, { cwd });
      results.push(result);
      const ev = this.evidence(goal.id, plan.version, "goal", 0, result);
      this.store.addEvidence(ev);
      evidenceIds.push(ev.id);
      emitGoalEvent({
        type: "goal.evidence",
        sessionId: goal.sessionId,
        goalId: goal.id,
        phaseKey: "goal",
        acceptanceId: acceptance.id,
        passed: result.passed,
        summary: result.summary,
      });
    }
    return { ok: allAcceptancePassed(results), results, evidenceIds };
  }

  private pause(goalId: string, reason: string, kind: "pause" | "budget" = "pause"): GoalRunOutcome {
    const goal = this.store.getGoal(goalId);
    if (!goal) return { kind: "failed", goalId, reason: "目标不存在" };
    this.store.updateGoal(goalId, { status: "paused", blockedReason: reason });
    this.decision(goalId, kind === "budget" ? "budget_capped" : "goal_paused", reason);
    emitGoalEvent({ type: "goal.status", sessionId: goal.sessionId, goalId, status: "paused", reason });
    return { kind: "paused", goalId, reason };
  }

  private block(goalId: string, reason: string): GoalRunOutcome {
    const goal = this.store.getGoal(goalId);
    if (!goal) return { kind: "failed", goalId, reason: "目标不存在" };
    this.store.updateGoal(goalId, { status: "blocked", blockedReason: reason });
    this.decision(goalId, "goal_blocked", reason);
    emitGoalEvent({ type: "goal.blocked", sessionId: goal.sessionId, goalId, reason });
    return { kind: "blocked", goalId, reason };
  }

  private complete(goalId: string): GoalRunOutcome {
    const goal = this.store.getGoal(goalId);
    if (!goal) return { kind: "failed", goalId, reason: "目标不存在" };
    this.store.updateGoal(goalId, { status: "completed", completedAt: this.now(), blockedReason: "" });
    this.decision(goalId, "goal_completed", "全部阶段与整体验收通过");
    emitGoalEvent({ type: "goal.completed", sessionId: goal.sessionId, goalId });
    return { kind: "completed", goalId };
  }

  /** 预算判定（unlimited ⇒ 永远 false；这是 GOAL-11 的唯一判定点） */
  private budgetExceeded(goal: GoalContract): string | null {
    if (goal.budget.mode !== "capped") return null;
    const { maxTokens, maxMinutes, maxTurns } = goal.budget;
    if (maxTokens !== undefined && goal.usage.tokens >= maxTokens) {
      return `达到预算上限：估算 token ${goal.usage.tokens} ≥ ${maxTokens}`;
    }
    if (maxTurns !== undefined && goal.usage.turns >= maxTurns) {
      return `达到预算上限：回合数 ${goal.usage.turns} ≥ ${maxTurns}`;
    }
    if (maxMinutes !== undefined) {
      const minutes = (this.now() - goal.usage.startedAt) / 60000;
      if (minutes >= maxMinutes) return `达到预算上限：墙钟 ${minutes.toFixed(1)} 分钟 ≥ ${maxMinutes}`;
    }
    return null;
  }

  /** 把一次回合的估算消耗计入目标（unlimited 时只用于显示，不参与停止） */
  private accountUsage(goal: GoalContract, turn: GoalTurnResult, promptChars: number): GoalContract {
    const estimated = Math.ceil((turn.output.length + promptChars) / 3);
    const usage = {
      tokens: goal.usage.tokens + estimated,
      turns: goal.usage.turns + 1,
      startedAt: goal.usage.startedAt,
    };
    this.store.updateGoal(goal.id, { usage });
    emitGoalEvent({
      type: "goal.usage",
      sessionId: goal.sessionId,
      goalId: goal.id,
      tokens: usage.tokens,
      turns: usage.turns,
    });
    return { ...goal, usage };
  }

  // ---------- 阶段 ----------

  private pickNextPhase(plan: GoalPlan): PlanPhase | null {
    const byKey = new Map(plan.phases.map((p) => [p.key, p]));
    for (const phase of plan.phases) {
      if (phase.status === "done") continue;
      if (phase.status === "blocked") continue;
      if (depsSatisfied(phase, byKey)) return phase;
    }
    return null;
  }

  private donePhaseSummaries(goalId: string, plan: GoalPlan): Array<{ phase: PlanPhase; evidence: GoalEvidence[] }> {
    return plan.phases
      .filter((p) => p.status === "done")
      .map((phase) => ({ phase, evidence: this.store.listEvidence(goalId, { phaseKey: phase.key, limit: 2 }) }));
  }

  private async runPhase(args: {
    goal: GoalContract;
    plan: GoalPlan;
    phase: PlanPhase;
    cwd: string;
    signal: AbortSignal;
    engine?: LLMEngine;
    onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;
    onEvent?: (event: LoopEvent) => void;
  }): Promise<PhaseOutcome> {
    const { goal, plan, phase, cwd, signal } = args;
    const runTurn = this.deps.runTurn ?? defaultRunTurn;
    const runAcceptance = this.deps.runAcceptance ?? defaultRunAcceptance;
    const index = plan.phases.findIndex((p) => p.key === phase.key);

    this.store.updatePhase(goal.id, plan.version, phase.key, {
      status: "active",
      startedAt: phase.startedAt ?? this.now(),
    });
    this.decision(goal.id, "phase_started", `开始阶段 ${phase.key}：${phase.title}`, {
      planVersion: plan.version,
      phaseKey: phase.key,
    });
    emitGoalEvent({
      type: "goal.phase",
      sessionId: goal.sessionId,
      goalId: goal.id,
      phaseKey: phase.key,
      title: phase.title,
      outcome: phase.outcome,
      index,
      total: plan.phases.length,
      status: "started",
    });

    let attempts = phase.attempts;
    let previousFailure = "";
    while (attempts < this.maxAttempts) {
      if (signal.aborted) {
        this.store.updatePhase(goal.id, plan.version, phase.key, { status: "active" });
        this.decision(goal.id, "phase_interrupted", `阶段 ${phase.key} 被用户停止`, {
          planVersion: plan.version,
          phaseKey: phase.key,
        });
        return { kind: "stopped", outcome: this.pause(goal.id, "用户停止") };
      }
      attempts++;
      this.store.updatePhase(goal.id, plan.version, phase.key, { attempts, status: "active" });

      const prompt = buildPhasePrompt({
        goal,
        plan,
        phase: { ...phase, attempts },
        attempt: attempts,
        previousFailure,
        donePhases: this.donePhaseSummaries(goal.id, plan),
      });

      const turn = await runTurn({
        sessionId: goal.sessionId,
        message: prompt,
        cwd,
        signal,
        /**
         * A1：阶段指令的 id 要可辨认（`goal-phase-<goalId>-<phaseKey>-<attempt>`）。
         * UI 据它渲染成「系统说明」，重开会话时不会被当成用户自己发的一段话；
         * 同一 goal/phase/attempt 重复注入是同 id 覆盖（不会叠两条一样的指令）。
         */
        messageId: goalPhaseMessageId(goal.id, phase.key, attempts),
        ...(args.engine ? { engine: args.engine } : {}),
        ...(args.onPermissionRequest ? { onPermissionRequest: args.onPermissionRequest } : {}),
        ...(args.onEvent ? { onEvent: args.onEvent } : {}),
      });

      // 记账（unlimited 时不影响是否继续）
      const withUsage = this.accountUsage(goal, turn, prompt.length);
      if (signal.aborted) {
        this.decision(goal.id, "phase_interrupted", `阶段 ${phase.key} 被用户停止`, {
          planVersion: plan.version,
          phaseKey: phase.key,
        });
        return { kind: "stopped", outcome: this.pause(goal.id, "用户停止") };
      }

      /**
       * A2（GOAL-18）：压缩后的上下文冲突由 `agentic-loop` 侧**直接判目标 blocked**
       * （`context_conflict`）。这里必须看到它并停止 —— 否则 Runner 会拿一个已阻塞的目标
       * 继续下一阶段（"假装还在推进"）。
       */
      const live = this.store.getGoal(goal.id);
      if (live && live.status === "blocked") {
        return {
          kind: "stopped",
          outcome: { kind: "blocked", goalId: goal.id, reason: live.blockedReason ?? "目标已阻塞" },
        };
      }
      if (live && live.status !== "active") {
        return {
          kind: "stopped",
          outcome: { kind: "paused", goalId: goal.id, reason: live.blockedReason ?? live.status },
        };
      }

      const budget = this.budgetExceeded(withUsage);
      if (budget) {
        this.decision(goal.id, "phase_interrupted", `阶段 ${phase.key} 因预算暂停：${budget}`, {
          planVersion: plan.version,
          phaseKey: phase.key,
        });
        return { kind: "stopped", outcome: this.pause(goal.id, budget, "budget") };
      }

      // 阶段门禁：**Runner 执行确定性验收**，模型自述不算
      const results: AcceptanceResult[] = [];
      for (const acceptance of phase.acceptance) {
        const result = await runAcceptance(acceptance, { cwd });
        results.push(result);
        this.store.addEvidence(this.evidence(goal.id, plan.version, phase.key, attempts, result));
        emitGoalEvent({
          type: "goal.evidence",
          sessionId: goal.sessionId,
          goalId: goal.id,
          phaseKey: phase.key,
          acceptanceId: acceptance.id,
          passed: result.passed,
          summary: result.summary,
        });
      }

      if (allAcceptancePassed(results)) {
        this.store.updatePhase(goal.id, plan.version, phase.key, {
          status: "done",
          completedAt: this.now(),
        });
        this.decision(goal.id, "phase_passed", `阶段 ${phase.key} 通过全部验收`, {
          planVersion: plan.version,
          phaseKey: phase.key,
        });
        emitGoalEvent({
          type: "goal.phase",
          sessionId: goal.sessionId,
          goalId: goal.id,
          phaseKey: phase.key,
          title: phase.title,
          outcome: phase.outcome,
          index,
          total: plan.phases.length,
          status: "passed",
        });
        return { kind: "passed" };
      }

      previousFailure = summarizeFailure(results);
      this.decision(goal.id, "phase_failed", `阶段 ${phase.key} 第 ${attempts} 次未通过：${previousFailure}`, {
        planVersion: plan.version,
        phaseKey: phase.key,
      });
      emitGoalEvent({
        type: "goal.phase",
        sessionId: goal.sessionId,
        goalId: goal.id,
        phaseKey: phase.key,
        title: phase.title,
        outcome: phase.outcome,
        index,
        total: plan.phases.length,
        status: "failed",
      });

      /**
       * GOAL-6：阶段内**没有 tool call** 且验收未达 ⇒ 自动继续（同一阶段）。
       *
       * 这里不是「停在原地等用户点继续」—— 而是把失败原因写进下一次提示词，
       * 明确告诉模型「你结束了，但验收没过，继续修」。尝试次数仍受 `maxAttempts` 约束。
       */
      if (turn.toolCallCount === 0) {
        /**
         * A1 / GOAL-16：**自动继续当前阶段**。
         *
         * 事实：模型以自然语言收尾（没有 tool call），但阶段验收没过。
         * 处置：不是停下来等用户点「继续」，而是**同一阶段内**再发一轮 ——
         * 把「你已经结束了但验收没过」写进下一次阶段指令，并留一条 `auto_continue` 决策
         * （权威日志；界面显示「自动继续（第 N 次）」用的就是它）。
         *
         * 边界：本轮仍计入 `maxAttempts`（默认 3）⇒ 连续空转会被无进展熔断接住，
         * 不会变成无限续跑。用户停止/审批/阻塞的判定都在这一句之前。
         */
        this.decision(
          goal.id,
          "auto_continue",
          `阶段 ${phase.key} 第 ${attempts} 次：模型没有调用任何工具且验收未通过 ⇒ 自动继续（第 ${attempts} 次）`,
          { planVersion: plan.version, phaseKey: phase.key, payload: { attempt: attempts } },
        );
        previousFailure =
          `上一轮你没有调用任何工具就结束了，但本阶段验收没有通过。不要只描述计划/结论 —— ` +
          `直接去把事情做完（改代码、跑命令、修失败），直到验收通过。\n\n${previousFailure}`;
      }

      // 无进展熔断（GOAL-7）：连续 N 次验收结果一模一样 ⇒ 不再空转
      if (noProgressStreak(this.store, goal.id, phase.key) >= this.noProgressLimit) {
        previousFailure = `连续 ${this.noProgressLimit} 次验收结果完全相同（没有任何进展）：\n${previousFailure}`;
        const replanned = await this.tryReplan({
          goal: withUsage,
          plan,
          phaseKey: phase.key,
          trigger: "phase_failed",
          evidenceIds: this.store.listEvidence(goal.id, { phaseKey: phase.key, limit: this.noProgressLimit * 3 }).map((e) => e.id),
          reason: `阶段 ${phase.key} 连续 ${this.noProgressLimit} 次无进展`,
          cwd,
          signal,
        });
        if (replanned.ok) return { kind: "replanned" };
        return { kind: "stopped", outcome: replanned.outcome };
      }
    }

    // 尝试用尽 ⇒ 重规划或阻塞（不允许无限重试同一阶段）
    const replanned = await this.tryReplan({
      goal,
      plan,
      phaseKey: phase.key,
      trigger: "phase_failed",
      evidenceIds: this.store.listEvidence(goal.id, { phaseKey: phase.key, limit: 12 }).map((e) => e.id),
      reason: `阶段 ${phase.key} 在 ${this.maxAttempts} 次尝试后仍未通过`,
      cwd,
      signal,
    });
    if (replanned.ok) return { kind: "replanned" };
    return { kind: "stopped", outcome: replanned.outcome };
  }

  // ---------- 重规划 ----------

  /**
   * 受控重规划（白名单 + 证据 + 版本化 + 保留已完成阶段）。
   *
   * 任何一条不满足 ⇒ **不重规划**（blocked），而不是「先改了再说」。
   */
  private async tryReplan(args: {
    goal: GoalContract;
    plan: GoalPlan;
    phaseKey?: string;
    trigger: ReplanTrigger;
    evidenceIds: string[];
    reason: string;
    cwd: string;
    signal: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; outcome: GoalRunOutcome }> {
    const { goal, plan, trigger, evidenceIds, reason, cwd, signal } = args;
    if (!isReplanTrigger(trigger)) {
      return { ok: false, outcome: this.block(goal.id, `不允许的重规划触发：${String(trigger)}`) };
    }
    if (evidenceIds.length === 0 && trigger !== "user_changed_goal") {
      // 无证据重规划 = 缺陷（ADR §4.3）。宁可阻塞让人看，也不允许模型凭感觉换方案。
      // 例外：用户改意图（`user_changed_goal`）的证据就是用户那句改动本身（记录在 decision 里）。
      this.decision(goal.id, "plan_rejected", `拒绝无证据重规划（${trigger}）`, {
        planVersion: plan.version,
        ...(args.phaseKey ? { phaseKey: args.phaseKey } : {}),
      });
      return { ok: false, outcome: this.block(goal.id, "重规划被拒绝：没有任何证据支持（无证据不允许重规划）") };
    }
    const maxReplans = this.deps.maxReplans ?? goal.maxReplans ?? 5;
    if (goal.replanCount >= maxReplans) {
      return {
        ok: false,
        outcome: this.block(goal.id, `重规划次数已达上限 ${maxReplans} 次：${reason}`),
      };
    }

    const replan = this.deps.replan ?? makeDefaultReplan(this.deps);
    const evidence = this.store.listEvidence(goal.id, { limit: 40 }).filter((e) => evidenceIds.includes(e.id));
    const donePhases = plan.phases
      .filter((p) => p.status === "done")
      .map((phase) => ({ phase, evidence: this.store.listEvidence(goal.id, { phaseKey: phase.key, limit: 2 }) }));

    let result: ReplanResult;
    try {
      result = await replan({
        goal: {
          statement: goal.statement,
          principles: goal.principles,
          nonGoals: goal.nonGoals,
          constraints: goal.constraints,
          acceptance: goal.acceptance,
        },
        plan,
        ...(args.phaseKey ? { failedPhaseKey: args.phaseKey } : {}),
        trigger,
        evidence,
        donePhases,
        cwd,
        deps: { complete: this.deps.complete ?? (async () => "") },
        signal,
      });
    } catch (e) {
      return { ok: false, outcome: this.block(goal.id, `重规划失败：${e instanceof Error ? e.message : String(e)}`) };
    }
    if (result.kind === "failed") {
      return { ok: false, outcome: this.block(goal.id, `重规划失败：${result.reason}`) };
    }

    const merged = this.mergeReplan(plan, result.plan, donePhases.map((d) => d.phase), goal.version);
    if ("error" in merged) {
      return { ok: false, outcome: this.block(goal.id, `重规划未通过合并校验：${merged.error}`) };
    }

    const revision: PlanRevision = {
      fromVersion: plan.version,
      trigger,
      reason,
      evidenceIds,
      diff: merged.diff,
      at: this.now(),
    };
    const nextPlan: GoalPlan = { ...merged.plan, revision };
    this.store.savePlan(nextPlan);
    const updated = this.store.getGoal(goal.id);
    this.store.updateGoal(goal.id, { replanCount: (updated?.replanCount ?? goal.replanCount) + 1 });
    this.decision(goal.id, "plan_replanned", `重规划 v${plan.version} → v${nextPlan.version}（${trigger}）：${reason}`, {
      planVersion: nextPlan.version,
      ...(args.phaseKey ? { phaseKey: args.phaseKey } : {}),
      payload: { evidenceIds, diff: revision.diff, trigger },
    });
    emitGoalEvent({
      type: "goal.replanned",
      sessionId: goal.sessionId,
      goalId: goal.id,
      fromVersion: plan.version,
      toVersion: nextPlan.version,
      trigger,
      reason,
    });
    return { ok: true };
  }

  /**
   * 合并重规划：**已完成阶段原样保留**（状态/证据/键都不变），新阶段重新编号为 `q1..qN`。
   *
   * 这一段是「已完成阶段不可删除」的**结构性保证** —— 不依赖模型自觉，
   * 模型即使把已完成的工作重排一遍，也只会被这里拒绝（重复 outcome）或被忽略（不写回）。
   */
  private mergeReplan(
    oldPlan: GoalPlan,
    newPlan: GoalPlan,
    donePhases: PlanPhase[],
    contractVersion: number,
  ): { plan: GoalPlan; diff: { added: string[]; removed: string[]; changed: string[] } } | { error: string } {
    const doneKeys = new Set(donePhases.map((p) => p.key));
    const doneOutcomes = new Set(donePhases.map((p) => normOutcome(p.outcome)));

    const keyMap = new Map<string, string>();
    newPlan.phases.forEach((p, i) => keyMap.set(p.key, `q${i + 1}`));

    const remapped: PlanPhase[] = [];
    for (const phase of newPlan.phases) {
      if (doneOutcomes.has(normOutcome(phase.outcome))) {
        return { error: `新计划又排了一遍已完成的工作（outcome 重复：${phase.outcome}）` };
      }
      const dependsOn: string[] = [];
      for (const dep of phase.dependsOn) {
        const mapped = keyMap.get(dep);
        if (mapped) {
          dependsOn.push(mapped);
          continue;
        }
        // 依赖已完成阶段是合法的（它们确实先做完了）；依赖「被删掉的未完成阶段」不合法
        if (doneKeys.has(dep)) continue;
        return { error: `新计划依赖了不存在的阶段 ${dep}` };
      }
      remapped.push({
        ...phase,
        key: keyMap.get(phase.key)!,
        order: donePhases.length + remapped.length,
        dependsOn,
        status: "pending",
        attempts: 0,
      });
    }

    const phases = [...donePhases.map((p) => ({ ...p })), ...remapped];
    const remainingOld = oldPlan.phases.filter((p) => p.status !== "done").map((p) => p.key);
    return {
      plan: {
        goalId: oldPlan.goalId,
        version: oldPlan.version + 1,
        contractVersion,
        strategy: newPlan.strategy,
        invariants: newPlan.invariants,
        phases,
        createdAt: newPlan.createdAt || this.now(),
      },
      diff: {
        added: remapped.map((p) => p.key),
        removed: remainingOld,
        changed: [],
      },
    };
  }

  // ---------- 主循环 ----------

  async run(args: RunGoalArgs): Promise<GoalRunOutcome> {
    const { goalId, cwd, signal } = args;
    if (!this.deps.runTurn && !args.engine) {
      return { kind: "failed", goalId, reason: "没有可用的 LLM 引擎（阶段执行需要 engine 或注入 runTurn）" };
    }
    const initial = this.store.getGoal(goalId);
    if (!initial) return { kind: "failed", goalId, reason: "目标不存在" };
    if (initial.status === "completed" || initial.status === "cancelled") {
      return { kind: "already-finished", goalId, status: initial.status };
    }
    if (initial.status === "paused") return { kind: "paused", goalId, reason: initial.blockedReason ?? "目标已暂停" };
    if (initial.status === "blocked") return { kind: "blocked", goalId, reason: initial.blockedReason ?? "目标已阻塞" };

    const plan0 = this.store.getActivePlan(goalId);
    if (!plan0) return { kind: "failed", goalId, reason: "目标没有计划（不应发生）" };

    /**
     * 契约在暂停期间被用户改过（`goal.version` > 计划的 `contractVersion`）⇒ 先重规划。
     *
     * 为什么不是"直接用旧计划继续"：旧计划的 outcome/验收是按**旧意图**写的，
     * 拿它继续执行等于把用户的新意图套进旧目标里（目标漂移的另一种形态）。
     * 这里用 `user_changed_goal` 触发（白名单内，证据就是用户那次改动本身）。
     */
    if (plan0.contractVersion < initial.version) {
      const replanned = await this.tryReplan({
        goal: initial,
        plan: plan0,
        trigger: "user_changed_goal",
        evidenceIds: [],
        reason: `用户修改了目标契约（v${plan0.contractVersion} → v${initial.version}）`,
        cwd,
        signal,
      });
      if (!replanned.ok) return replanned.outcome;
      const after = this.store.getGoal(goalId);
      if (after) initial.version = after.version;
    }

    try {
      while (true) {
        if (signal.aborted) return this.pause(goalId, "用户停止");
        const goal = this.store.getGoal(goalId);
        if (!goal) return { kind: "failed", goalId, reason: "目标不存在" };
        if (goal.status !== "active") {
          return goal.status === "completed"
            ? { kind: "completed", goalId }
            : { kind: "paused", goalId, reason: goal.blockedReason ?? goal.status };
        }
        const budget = this.budgetExceeded(goal);
        if (budget) return this.pause(goalId, budget, "budget");

        const plan = this.store.getActivePlan(goalId);
        if (!plan) return this.block(goalId, "目标计划丢失（存储不可读）");

        const phase = this.pickNextPhase(plan);
        if (!phase) {
          if (plan.phases.length > 0 && plan.phases.every((p) => p.status === "done")) {
            const verdict = await this.verifyGoalAcceptance(goal, cwd, plan);
            if (verdict.ok) return this.complete(goalId);
            const detail = summarizeFailure(verdict.results);
            const replanned = await this.tryReplan({
              goal,
              plan,
              trigger: "acceptance_unreachable",
              evidenceIds: verdict.evidenceIds,
              reason: `全部阶段完成但整体验收未通过：${detail}`,
              cwd,
              signal,
            });
            if (replanned.ok) continue;
            return replanned.outcome;
          }
          return this.block(goalId, "计划里没有可执行的阶段（依赖未满足或阶段状态异常）");
        }

        const outcome = await this.runPhase({
          goal,
          plan,
          phase,
          cwd,
          signal,
          ...(args.engine ? { engine: args.engine } : {}),
          ...(args.onPermissionRequest ? { onPermissionRequest: args.onPermissionRequest } : {}),
          ...(args.onEvent ? { onEvent: args.onEvent } : {}),
        });
        if (outcome.kind === "replanned") continue;
        if (outcome.kind === "stopped") return outcome.outcome;
        // passed → 继续下一阶段（自动，无用户点击）
      }
    } catch (e) {
      const reason = `目标执行异常：${e instanceof Error ? e.message : String(e)}`;
      return this.pause(goalId, reason);
    }
  }
}
