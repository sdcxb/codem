/**
 * 目标上下文：**每轮注入 + 阶段提示词 + 状态视图**。
 *
 * ## 为什么单独一个模块（GOAL-12 的结构性答案）
 *
 * 目标上下文**不能只靠对话历史**：压缩会把早期消息折叠掉，那样「目标/计划/当前阶段/验收」
 * 就丢了。本模块的三个函数都是**从存储现算**的：
 *
 * - `buildGoalModeContext`：agent 循环每轮迭代把它并进**尾部易变上下文**
 *   （与时间上下文同一通道，不碰 system 前缀 —— 前缀缓存判据 `dsh-d5-*` 守这条）；
 * - `buildPhasePrompt`：Runner 每一阶段发给 `executeSessionTurn` 的那条消息；
 * - `buildGoalView`：UI 状态条/面板读的投影（不含命令全文，避免把整份计划塞进界面状态）。
 *
 * 三者都不缓存历史、只读存储 ⇒ 压缩删掉多少旧消息都不影响目标是否「还在」。
 */

import type { GoalStore } from "./store";
import { getGoalStore } from "./store";
import type {
  Acceptance,
  GoalContract,
  GoalEvidence,
  GoalPlan,
  GoalView,
  PlanPhase,
} from "./types";

/** 注入/提示词里一条验收的单行描述（命令原文要保留：验收是确定性的） */
function acceptanceLine(a: Acceptance): string {
  const exit = a.expectExitCode !== undefined && a.expectExitCode !== 0 ? ` 且退出码 ${a.expectExitCode}` : "";
  const out = a.expectOutput ? ` 且输出包含「${a.expectOutput}」` : "";
  const body =
    a.kind === "command" || a.kind === "test"
      ? `命令 \`${a.command ?? ""}\`${exit}${out}`
      : `文件 ${a.path ?? ""}${a.contains ? ` 包含「${a.contains}」` : " 存在"}`;
  return `[${a.kind}] ${a.description} —— ${body}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function phaseStatusTag(p: PlanPhase): string {
  return p.status === "done" ? "done" : p.status === "active" ? "active" : p.status;
}

/**
 * 目标模式的**尾部上下文段**（agent 循环每轮重新生成）。
 *
 * 返回空串 = 该会话没有活跃目标 ⇒ 一个字都不注入（与时间上下文同一条纪律：
 * 没有事实就不写文本，避免把普通对话变成「永远带一段固定话」）。
 */
export function buildGoalModeContext(
  sessionId: string,
  opts: { store?: GoalStore; maxEvidence?: number } = {},
): string {
  const store = opts.store ?? getGoalStore();
  let goal: GoalContract | null = null;
  try {
    goal = store.getLiveGoalForSession(sessionId);
  } catch {
    return "";
  }
  if (!goal) return "";
  const plan = store.getActivePlan(goal.id);
  const evidence = store.listEvidence(goal.id, { limit: opts.maxEvidence ?? 4 });
  const lines: string[] = [];

  lines.push("# Goal Mode（长程目标 · 自动推进）");
  lines.push("");
  lines.push("## 目标契约（不可变 —— 要改必须由用户确认，你不能自行修改）");
  lines.push(`- 目标：${truncate(goal.statement, 600)}`);
  if (goal.principles.length > 0) lines.push(`- 原则：${goal.principles.join("；")}`);
  if (goal.nonGoals.length > 0) lines.push(`- 非目标（明确不做）：${goal.nonGoals.join("；")}`);
  if (goal.constraints.length > 0) lines.push(`- 约束：${goal.constraints.join("；")}`);
  lines.push("- 整体验收（由系统执行，模型自述不算）：");
  for (const a of goal.acceptance.slice(0, 8)) lines.push(`  - ${a.id} ${acceptanceLine(a)}`);
  lines.push(
    `- 预算：${goal.budget.mode === "capped" ? `capped（token≥${goal.budget.maxTokens ?? "-"} / 时间≥${goal.budget.maxMinutes ?? "-"} 分钟 / 回合≥${goal.budget.maxTurns ?? "-"} 时暂停）` : "unlimited（不因 token/时间/轮数停止；靠验收/阻塞/用户停止结束）"}`,
  );

  if (!plan) {
    lines.push("");
    lines.push("## 计划");
    lines.push("- 尚未生成（规划器只读分析中）");
    return lines.join("\n");
  }

  const done = plan.phases.filter((p) => p.status === "done").length;
  lines.push("");
  lines.push(`## 里程碑计划 v${plan.version}（${done}/${plan.phases.length} 阶段已完成）`);
  lines.push(`- 策略：${truncate(plan.strategy, 400)}`);
  for (const p of plan.phases) {
    lines.push(`- [${phaseStatusTag(p)}] ${p.key} ${p.title} —— ${truncate(p.outcome, 200)}`);
  }
  if (plan.invariants.length > 0) lines.push(`- 不变式（执行期间必须始终成立）：${plan.invariants.join("；")}`);

  const active = plan.phases.find((p) => p.status === "active");
  if (active) {
    lines.push("");
    lines.push(`## 当前阶段 ${active.key}：${active.title}`);
    lines.push(`- 交付物：${truncate(active.outcome, 400)}`);
    lines.push("- 本阶段验收（系统执行）：");
    for (const a of active.acceptance) lines.push(`  - ${a.id} ${acceptanceLine(a)}`);
    if (active.covers.length > 0) lines.push(`- 覆盖整体验收：${active.covers.join(", ")}`);
    if (active.risks.length > 0) lines.push(`- 风险：${active.risks.join("；")}`);
  }

  if (evidence.length > 0) {
    lines.push("");
    lines.push("## 最近证据（系统执行验收的结果）");
    for (const e of evidence) {
      lines.push(`- [${e.passed ? "pass" : "fail"}] ${e.phaseKey}/${e.acceptanceId}：${truncate(e.summary, 200)}`);
    }
  }

  lines.push("");
  lines.push(
    "执行纪律：阶段内实现路径自由；**不要**修改契约或计划；结束时系统会执行上面的验收 —— " +
      "验收不过会被自动退回继续修；已完成阶段不要重做。",
  );
  return lines.join("\n");
}

/**
 * 每一阶段发给 `executeSessionTurn` 的消息。
 *
 * 关键内容（缺一条就会退化成「短步目标」）：
 * - 目标契约摘要（为什么做）；
 * - 本阶段 outcome + 验收（做完的定义）；
 * - **已完成阶段清单**（不要重做已做过的；这是跨阶段一致性的来源）；
 * - 上一次尝试的失败原因（修复而不是重演）。
 */
export function buildPhasePrompt(args: {
  goal: GoalContract;
  plan: GoalPlan;
  phase: PlanPhase;
  attempt: number;
  previousFailure?: string;
  donePhases: Array<{ phase: PlanPhase; evidence: GoalEvidence[] }>;
}): string {
  const { goal, plan, phase, attempt, previousFailure, donePhases } = args;
  const index = plan.phases.findIndex((p) => p.key === phase.key);
  const lines: string[] = [];
  lines.push(`【目标模式 · 里程碑 ${index + 1}/${plan.phases.length} · 第 ${attempt} 次执行】`);
  lines.push("");
  lines.push("## 目标（不可变契约）");
  lines.push(goal.statement);
  if (goal.principles.length > 0) lines.push(`原则：${goal.principles.join("；")}`);
  if (goal.nonGoals.length > 0) lines.push(`非目标（明确不做）：${goal.nonGoals.join("；")}`);
  if (goal.constraints.length > 0) lines.push(`约束：${goal.constraints.join("；")}`);
  lines.push("整体验收：");
  for (const a of goal.acceptance) lines.push(`- ${a.id} ${acceptanceLine(a)}`);
  lines.push("");
  lines.push(`## 本阶段交付物（必须达成，不是「做一点」）`);
  lines.push(`${phase.key} ${phase.title}：${phase.outcome}`);
  lines.push("");
  lines.push("## 本阶段验收（系统会执行；模型说「完成」不算）");
  for (const a of phase.acceptance) lines.push(`- ${a.id} ${acceptanceLine(a)}`);
  lines.push("");
  if (donePhases.length > 0) {
    lines.push("## 已完成阶段（不要重做）");
    for (const { phase: p, evidence } of donePhases) {
      const ev = evidence.length > 0 ? `（证据：${truncate(evidence[evidence.length - 1].summary, 160)}）` : "";
      lines.push(`- ${p.key} ${p.title} —— ${truncate(p.outcome, 200)}${ev}`);
    }
    lines.push("");
  }
  if (phase.dependsOn.length > 0) {
    lines.push(`依赖：${phase.dependsOn.join(", ")}（已完成，不要重做）`);
    lines.push("");
  }
  if (plan.invariants.length > 0) {
    lines.push(`不变式（必须始终成立）：${plan.invariants.join("；")}`);
    lines.push("");
  }
  if (previousFailure) {
    lines.push("## 上一次执行未通过验收（这次必须先修掉它）");
    lines.push(truncate(previousFailure, 1600));
    lines.push("");
  }
  lines.push(
    "## 执行要求",
    `- 只做本阶段的事；不要顺手改目标契约/计划（那需要用户确认）；`,
    `- 阶段内可以自由选择实现路径、跑命令、读文件、修 bug；`,
    `- 结束时请给出本阶段做了什么、如何被验收证明；系统随后会执行上面的验收；`,
    `- 如果确实被外部条件阻塞（缺权限/缺信息/不可逆动作），**明确说明**，不要假装完成。`,
  );
  if (index === plan.phases.length - 1) {
    lines.push("- 这是最后一个阶段：完成后系统会再跑一次整体验收。");
  }
  return lines.join("\n");
}

/** UI 投影：状态条/面板用（找不到目标返回 null） */
export function buildGoalView(
  sessionId: string,
  opts: { store?: GoalStore; includeClosed?: boolean } = {},
): GoalView | null {
  const store = opts.store ?? getGoalStore();
  /**
   * 可见性：active / blocked / paused 都要显示（paused 是"可继续"的状态，
   * 状态条要给出「继续目标」的入口）；completed / cancelled 只在面板历史里看。
   */
  const candidate = store.getLiveGoalForSession(sessionId) ?? store.getLatestGoalForSession(sessionId);
  const visible = opts.includeClosed
    ? candidate
    : candidate && (candidate.status === "paused" || candidate.status === "active" || candidate.status === "blocked")
      ? candidate
      : null;
  if (!visible) return null;
  const goal = visible;
  const plan = store.getActivePlan(goal.id);
  const phases = plan?.phases ?? [];
  const done = phases.filter((p) => p.status === "done");
  const activeIndex = phases.findIndex((p) => p.status === "active");
  const active = activeIndex >= 0 ? phases[activeIndex] : undefined;
  const recentEvidence = store.listEvidence(goal.id, { limit: 5 });
  const lastEvidence = recentEvidence[recentEvidence.length - 1];
  const lastFailureEvidence = [...recentEvidence].reverse().find((e) => !e.passed);
  const autoContinues = store.listDecisions(goal.id).filter((d) => d.kind === "auto_continue").length;
  return {
    sessionId,
    goalId: goal.id,
    status: goal.status,
    statement: goal.statement,
    planVersion: plan?.version ?? 0,
    phaseTotal: phases.length,
    phaseDone: done.length,
    ...(active
      ? {
          activePhase: {
            key: active.key,
            title: active.title,
            outcome: active.outcome,
            index: activeIndex,
          },
        }
      : {}),
    ...(done.length > 0 ? { lastCompleted: { key: done[done.length - 1].key, title: done[done.length - 1].title } } : {}),
    replanCount: goal.replanCount,
    maxReplans: goal.maxReplans,
    autoContinues,
    budget: goal.budget,
    usage: goal.usage,
    ...(goal.blockedReason ? { blockedReason: goal.blockedReason } : {}),
    ...(lastFailureEvidence && lastEvidence && !lastEvidence.passed
      ? { lastFailure: lastFailureEvidence.summary }
      : {}),
    updatedAt: goal.updatedAt,
  };
}
