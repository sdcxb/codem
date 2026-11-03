/**
 * 目标模式事件（进程内广播）。
 *
 * 为什么不用 `SessionMessageBus`：那张总线是**会话间委派**的通道（消息类型是封闭联合），
 * 目标事件是「同一会话内的目标生命周期」，消费者是 UI 状态条/面板与运行时本身。
 * 单独一个极小的发射器更不容易把两类语义搅在一起（也不改既有总线类型）。
 *
 * 事件**只做通知**：状态一律从存储重算（`state.ts::refreshGoalView`），
 * 事件里不携带"真相"，所以丢一条事件不会让界面永久错位（下次刷新自愈）。
 */

export type GoalEvent =
  | { type: "goal.planning"; sessionId: string }
  | { type: "goal.created"; sessionId: string; goalId: string; planVersion: number }
  | { type: "goal.status"; sessionId: string; goalId: string; status: string; reason?: string }
  | {
      type: "goal.phase";
      sessionId: string;
      goalId: string;
      phaseKey: string;
      title: string;
      outcome: string;
      index: number;
      total: number;
      status: "started" | "passed" | "failed" | "interrupted";
    }
  | {
      type: "goal.evidence";
      sessionId: string;
      goalId: string;
      phaseKey: string;
      acceptanceId: string;
      passed: boolean;
      summary: string;
    }
  | {
      type: "goal.replanned";
      sessionId: string;
      goalId: string;
      fromVersion: number;
      toVersion: number;
      trigger: string;
      reason: string;
    }
  | { type: "goal.blocked"; sessionId: string; goalId: string; reason: string }
  | { type: "goal.completed"; sessionId: string; goalId: string }
  | { type: "goal.usage"; sessionId: string; goalId: string; tokens: number; turns: number };

type GoalEventListener = (event: GoalEvent) => void;

const listeners = new Set<GoalEventListener>();

export function subscribeGoalEvents(listener: GoalEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播一条事件；监听器异常**不许**影响 Runner（观测设施的第一条纪律） */
export function emitGoalEvent(event: GoalEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (e) {
      console.warn("[Goal] event listener failed:", e);
    }
  }
}
