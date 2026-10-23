/**
 * 运行中的 agent loop 的 abort 控制器登记表。
 *
 * 删除会话时 store 只删数据，拿不到 App 里的 abortControllersRef；
 * 不先 abort 就删，正在跑的工具/模型回调还会写消息，触发
 * `FOREIGN KEY constraint failed` / 跨会话写入。这张表让 store 能先停 loop 再删。
 */
const controllers = new Map<string, AbortController>();

export function registerSessionAbort(sessionId: string, controller: AbortController): void {
  controllers.set(sessionId, controller);
}

export function unregisterSessionAbort(sessionId: string, controller?: AbortController): void {
  if (!controller || controllers.get(sessionId) === controller) controllers.delete(sessionId);
}

export function abortSessionLoop(sessionId: string): void {
  const c = controllers.get(sessionId);
  if (!c) return;
  controllers.delete(sessionId);
  try { c.abort(); } catch { /* 已 abort 不重复 */ }
}
