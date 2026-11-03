/**
 * 目标模式的 UI 状态投影（会话级缓存 + 订阅）。
 *
 * 设计：**界面状态永远从存储重算**（`buildGoalView`），事件只用来触发重算。
 * 这样「事件丢了一条」「用户切走又切回」「重启后首次打开」都不会让状态条停在旧值 ——
 * 这是本项目反复吃亏的「两份真相」问题的最便宜解法。
 *
 * 订阅者（React 组件）通过 `subscribeGoalView` + `getGoalViewVersion` 使用
 * `useSyncExternalStore`（快照必须是稳定引用：同一版本返回同一个对象）。
 */

import { buildGoalView } from "./context";
import type { GoalStore } from "./store";
import { getGoalStore } from "./store";
import type { GoalView } from "./types";

const cache = new Map<string, GoalView | null>();
/** 「正在深规划」的会话（规划调用是纯只读分析，没有目标行可读，所以单独记） */
const planning = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (e) {
      console.warn("[Goal] view listener failed:", e);
    }
  }
}

/** 重算某会话的目标视图（并通知订阅者） */
export function refreshGoalView(sessionId: string, store: GoalStore = getGoalStore()): GoalView | null {
  const next = buildGoalView(sessionId, { store });
  const prev = cache.get(sessionId) ?? null;
  cache.set(sessionId, next);
  // 内容没变就不通知（避免每轮都让状态条重渲染）
  const changed = JSON.stringify(prev) !== JSON.stringify(next);
  if (changed) notify();
  return next;
}

/** 读缓存（没有缓存时现算一次；不通知） */
export function getGoalView(sessionId: string, store: GoalStore = getGoalStore()): GoalView | null {
  if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
  const view = buildGoalView(sessionId, { store });
  cache.set(sessionId, view);
  return view;
}

/** 「正在深规划」标记（规划失败/回落后必须清掉，否则状态条会永远显示"规划中"） */
export function markGoalPlanning(sessionId: string, active: boolean): void {
  const had = planning.has(sessionId);
  if (active) planning.set(sessionId, Date.now());
  else planning.delete(sessionId);
  if (had !== planning.has(sessionId)) notify();
}

export function isGoalPlanning(sessionId: string): boolean {
  return planning.has(sessionId);
}

export function getGoalViewVersion(): number {
  return version;
}

export function subscribeGoalView(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
