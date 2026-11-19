/**
 * GoalBarConnected — 把「目标」数据接到 `GoalBar` 上（第 5 轮修的**真缺陷**）。
 *
 * ## 现场
 *
 * `app.goal-bar` 插槽在 `InputArea` 里这样渲染：
 *
 *     <SlotBridge name="app.goal-bar" fallback={null} />
 *
 * **一个 props 都没传**，而 `GoalBar` 的判据是 `goal === undefined ⇒ return null`。
 * 于是：目标模式正常创建、`uiGoal` 服务也注册成功，但输入区上方**永远什么也没有**
 * （没有加载态、没有空态、没有任何痕迹）。这类"插件注册成功、界面空无一物"是最难自查的形态。
 *
 * ## 为什么不是给 SlotBridge 传 props
 *
 * `SlotBridge` 的属性由宿主（InputArea）提供，而"当前会话的目标"属于**领域数据**，
 * 不该塞进输入区组件的 props（那会让输入区依赖 goal runtime）。这里由 UI 插件自己
 * 订阅 `subscribeGoalEvents` + `getGoalDetails`，输入区保持与目标系统零耦合。
 *
 * ## 语义映射
 *
 * `GoalView.status`（active / paused / blocked / completed / cancelled）
 * → `GoalBar.phase`（active / paused / blocked / complete）。`cancelled` 视为无目标。
 */

import { useCallback, useEffect, useState } from "react";
import { GoalBar } from "./GoalBar";
import { useAppStore } from "../store";
import { getGoalDetails, resumeSessionGoal, stopSessionGoal } from "../core/goal/runtime";
import { subscribeGoalEvents } from "../core/goal/events";

interface GoalSnapshot {
  id: string;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: { message: string };
}

type ViewStatus = "active" | "paused" | "blocked" | "completed" | "cancelled" | string;

function toPhase(status: ViewStatus): GoalSnapshot["phase"] | null {
  if (status === "active") return "active";
  if (status === "paused") return "paused";
  if (status === "blocked") return "blocked";
  if (status === "completed") return "complete";
  /* cancelled 与未知状态都不显示（宁可少一条横幅，也不误导用户"目标还在"） */
  return null;
}

/** 读当前会话的目标快照；无目标返回 null */
export function readGoalSnapshot(sessionId: string | null): GoalSnapshot | null {
  if (!sessionId) return null;
  const details = getGoalDetails(sessionId);
  if (!details) return null;
  const phase = toPhase(details.view.status);
  if (!phase) return null;
  const statement = (details.view.statement || details.goal.statement || "").trim();
  if (!statement) return null;
  return { id: details.goal.id, objective: statement, phase };
}

export function GoalBarConnected() {
  const sessionId = useAppStore((s) => s.loadedSessionId);
  const [goal, setGoal] = useState<GoalSnapshot | null>(null);

  const reload = useCallback(() => {
    try {
      setGoal(readGoalSnapshot(sessionId));
    } catch {
      /* 读目标失败不该让输入区崩掉：当作无目标（下一轮事件会再试） */
      setGoal(null);
    }
  }, [sessionId]);

  useEffect(() => {
    reload();
    return subscribeGoalEvents(() => reload());
  }, [reload]);

  const onPause = useCallback(() => {
    if (sessionId) stopSessionGoal(sessionId);
    reload();
  }, [sessionId, reload]);

  const onResume = useCallback(() => {
    if (sessionId) resumeSessionGoal(sessionId);
    reload();
  }, [sessionId, reload]);

  const onClear = useCallback(() => {
    if (sessionId) stopSessionGoal(sessionId);
    setGoal(null);
  }, [sessionId]);

  if (!goal) return null;
  return <GoalBar goal={goal} onPause={onPause} onResume={onResume} onClear={onClear} />;
}
