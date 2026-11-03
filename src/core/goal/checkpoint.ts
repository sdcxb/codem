/**
 * 压缩检查点（A2 / GOAL-17）。
 *
 * ## 为什么压缩需要"目标检查点"
 *
 * 长阶段跑着跑着上下文水位到阈值，压缩会折叠早期消息。**目标上下文本来就不依赖对话历史**
 * （`context.ts` 每轮从存储现算并注入尾部），所以"压缩后目标丢失"这条路已经被结构性地堵住。
 * 但还有两件事故形态需要留痕与拦截：
 *
 * 1. **压缩正好发生在阶段中途** —— 用户/审计需要看到"这一阶段在压缩前后是同一个阶段、
 *    同一批未完成验收"，而不是"压缩了一下，然后它重新开始"；
 * 2. **压缩把 tool_call/tool_result 配对切坏了** —— 请求侧有 `enforceToolPairing` 兜底
 *    （会剥掉不合法的一半），但它**不该在目标模式里静默发生**：那意味着模型看到的历史
 *    被改写了、却还在按"目标要求"继续。这里把它升级成 `context_conflict`：目标 blocked，
 *    原因可见，等人决定（而不是假装继续）。
 *
 * 本模块只写**决策记录**（`goal_decisions`）与**标记目标阻塞**，不改消息、不改计划。
 */

import { emitGoalEvent } from "./events";
import type { GoalStore } from "./store";
import { getGoalStore } from "./store";

export interface GoalCompactionCheckpoint {
  goalId: string;
  sessionId: string;
  planVersion: number;
  phaseKey: string;
  attempts: number;
  /** 压缩时还没达成的验收 id（恢复的依据） */
  pendingAcceptanceIds: string[];
}

/**
 * 压缩前：若该会话有活跃目标，写一条 `phase_checkpoint` 决策并返回检查点。
 *
 * 返回 null = 没有活跃目标（普通会话压缩，不写任何目标记录）。
 * 任何异常都吞掉并留一行 warn：**观测设施写不进去不该影响压缩本身**
 * （与 `recordLoopStop` / `turn_end` 同一条纪律）。
 */
export function writeGoalCompactionCheckpoint(
  sessionId: string,
  store: GoalStore = getGoalStore(),
): GoalCompactionCheckpoint | null {
  try {
    const goal = store.getLiveGoalForSession(sessionId);
    if (!goal) return null;
    const plan = store.getActivePlan(goal.id);
    const phase = plan?.phases.find((p) => p.status === "active") ?? null;
    const checkpoint: GoalCompactionCheckpoint = {
      goalId: goal.id,
      sessionId,
      planVersion: plan?.version ?? 0,
      phaseKey: phase?.key ?? "",
      attempts: phase?.attempts ?? 0,
      pendingAcceptanceIds: phase?.acceptance.map((a) => a.id) ?? [],
    };
    store.addDecision({
      id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId: goal.id,
      kind: "phase_checkpoint",
      reason: `压缩前检查点：阶段 ${checkpoint.phaseKey || "(无)"} 第 ${checkpoint.attempts} 次执行`,
      planVersion: checkpoint.planVersion,
      ...(checkpoint.phaseKey ? { phaseKey: checkpoint.phaseKey } : {}),
      payload: {
        phaseKey: checkpoint.phaseKey,
        attempts: checkpoint.attempts,
        pendingAcceptanceIds: checkpoint.pendingAcceptanceIds,
      },
      createdAt: Date.now(),
    });
    return checkpoint;
  } catch (e) {
    console.warn("[Goal] 压缩前检查点写入失败（不影响压缩）:", e);
    return null;
  }
}

/**
 * 压缩后：记录"从检查点恢复"，并如实报告移除了多少条消息。
 *
 * 这里**不重新规划、不重跑已完成阶段** —— 状态本来就都在存储里，下一轮迭代的目标注入会
 * 从同一份存储重新渲染。这条决策只是让审计能对上"压缩前后是同一阶段"。
 */
export function finishGoalCompactionCheckpoint(
  checkpoint: GoalCompactionCheckpoint | null,
  removed: number,
  store: GoalStore = getGoalStore(),
): void {
  if (!checkpoint) return;
  try {
    store.addDecision({
      id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId: checkpoint.goalId,
      kind: "phase_resumed",
      reason: `压缩后恢复检查点：阶段 ${checkpoint.phaseKey || "(无)"}（移除 ${Math.max(0, removed)} 条消息，验收未变）`,
      planVersion: checkpoint.planVersion,
      ...(checkpoint.phaseKey ? { phaseKey: checkpoint.phaseKey } : {}),
      payload: { removed, pendingAcceptanceIds: checkpoint.pendingAcceptanceIds },
      createdAt: Date.now(),
    });
    emitGoalEvent({
      type: "goal.status",
      sessionId: checkpoint.sessionId,
      goalId: checkpoint.goalId,
      status: "active",
      reason: "compaction_resumed",
    });
  } catch (e) {
    console.warn("[Goal] 压缩后恢复记录失败:", e);
  }
}

/**
 * 压缩/折叠把工具配对切坏（`enforceToolPairing` 剥掉了调用或结果）⇒ 目标 blocked。
 *
 * 为什么必须是 **blocked 而不是继续**：模型看到的历史已经和它实际做过的操作不一致，
 * 它要么重复劳动、要么基于错误前提继续改代码。目标模式不允许这种"看起来还在推进"。
 *
 * @returns 是否真的把某个目标阻塞了（没有活跃目标 ⇒ false，普通会话不受影响）
 */
export function reportGoalContextConflict(
  sessionId: string,
  detail: string,
  store: GoalStore = getGoalStore(),
): boolean {
  try {
    const goal = store.getLiveGoalForSession(sessionId);
    if (!goal) return false;
    const reason = `context_conflict：${detail}（压缩后工具调用/结果不再成对，已停止而不是静默截断）`;
    store.updateGoal(goal.id, { status: "blocked", blockedReason: reason });
    store.addDecision({
      id: `gd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goalId: goal.id,
      kind: "goal_blocked",
      reason,
      createdAt: Date.now(),
    });
    emitGoalEvent({ type: "goal.blocked", sessionId, goalId: goal.id, reason });
    return true;
  } catch (e) {
    console.warn("[Goal] context_conflict 记录失败:", e);
    return false;
  }
}
