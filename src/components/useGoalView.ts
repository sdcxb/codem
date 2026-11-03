/**
 * 目标模式视图的 React 绑定（`useSyncExternalStore`）。
 *
 * 为什么这样做：目标状态是**进程级**的（一个会话最多一个目标），
 * 状态条、面板、ContinueBar 门控都要读它。用 store + 订阅（而不是把
 * 目标作为 props 从 App 一层层传下去）能让"目标变了 ⇒ 所有读它的地方一起刷新"
 * 变成机制而不是手工同步。
 *
 * 快照稳定性：`getGoalViewVersion()` 只在内容真的变了时才 +1
 * （`state.ts::refreshGoalView` 做了 JSON 比对），所以同一版本下
 * `getGoalView(sessionId)` 返回同一引用。
 */
import { useCallback, useSyncExternalStore } from "react";

import {
  getGoalView,
  getGoalViewVersion,
  isGoalPlanning,
  refreshGoalView,
  subscribeGoalView,
} from "../core/goal/state";
import type { GoalView } from "../core/goal/types";

/** 订阅"目标视图版本号"（版本变了 ⇒ 依赖它的组件重渲染） */
function useGoalVersion(): number {
  const subscribe = useCallback((onChange: () => void) => subscribeGoalView(onChange), []);
  return useSyncExternalStore(subscribe, getGoalViewVersion, getGoalViewVersion);
}

export function useGoalView(sessionId: string | undefined | null): GoalView | null {
  useGoalVersion();
  return sessionId ? getGoalView(sessionId) : null;
}

/** 该会话是否正在深规划（状态条上的「深规划中…」） */
export function useGoalPlanning(sessionId: string | undefined | null): boolean {
  useGoalVersion();
  return sessionId ? isGoalPlanning(sessionId) : false;
}

/** 打开会话/刷新面板时重算一次（幂等；不在渲染期写状态） */
export function refreshGoalViewFor(sessionId: string | undefined | null): void {
  if (sessionId) refreshGoalView(sessionId);
}
