/**
 * 分块渲染的安全起点。
 *
 * unified mode 下，一个 assistant 回合会被合并成一个视觉气泡：组头 `skip=false`，
 * 组内后续条目 `skip=true`。如果 `length - limit` 正好落在组中间，从那里切片会
 * 丢掉组头，整组都不渲染。起点必须回退到该组第一个非 skip 条目。
 */
export function safeRenderStart(entries: Array<{ skip: boolean }>, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return Math.max(0, entries.length);
  let start = Math.max(0, entries.length - Math.floor(limit));
  while (start > 0 && entries[start]?.skip) start--;
  return start;
}
