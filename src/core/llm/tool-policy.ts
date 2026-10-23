/**
 * 会话级工具策略（进程内）。
 *
 * 项目 thread 的职责是**在当前 worktree 里把一件事做完并写报告**；
 * 它不应该再开新会话、把手上的活委派出去、或者等一个永远不来的 delegation。
 * 真机 R3：三个 thread 同时进入 wait_for_delegation，报告一份没产出。
 *
 * 这里按 sessionId 记录"本次 loop 不可见的工具"，由 AgenticLoop 在生成
 * 工具定义时过滤；loop 结束由 App 清理。不是全局禁用——普通会话/协调者仍可用委派。
 */
const disabledBySession = new Map<string, Set<string>>();

export function setSessionDisabledTools(sessionId: string, toolIds: string[]): void {
  if (!sessionId || toolIds.length === 0) return;
  disabledBySession.set(sessionId, new Set(toolIds));
}

export function clearSessionDisabledTools(sessionId: string): void {
  disabledBySession.delete(sessionId);
}

export function isToolDisabledForSession(sessionId: string | undefined, toolId: string): boolean {
  if (!sessionId) return false;
  return disabledBySession.get(sessionId)?.has(toolId) ?? false;
}

/** 从工具定义里剔除当前会话不可见的工具（AgenticLoop 与判定共用这一条）。 */
export function filterToolDefsForSession<T extends { name: string }>(sessionId: string | undefined, defs: T[]): T[] {
  if (!sessionId) return defs;
  const disabled = disabledBySession.get(sessionId);
  if (!disabled?.size) return defs;
  return defs.filter((d) => !disabled.has(d.name));
}

/** thread 里禁止的工具：委派/交接/查询委派结果。 */
export const THREAD_DISABLED_TOOLS = [
  "delegate_to_session",
  "handoff_to_new_session",
  "wait_for_delegation",
  "query_session_result",
  "list_sessions",
  "cancel_delegation",
];
