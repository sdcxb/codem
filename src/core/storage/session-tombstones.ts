/**
 * 本进程内的"会话已删除"墓碑。
 *
 * 删除会话是同步删行，但正在跑的 agent loop / 工具回调仍可能调用
 * `MessageStorage.createMessage(sessionId)`；DB 会报 FOREIGN KEY。
 * 这里只做进程内短路：删除后不再接受该会话的新消息（JSONL 也不再追加）。
 * 跨重启的权威墓碑仍在 session-jsonl 的 session tombstone 里。
 */
const deleted = new Set<string>();

export function markSessionDeleted(sessionId: string): void {
  if (sessionId) deleted.add(sessionId);
}

export function clearSessionDeleted(sessionId: string): void {
  deleted.delete(sessionId);
}

export function isSessionDeleted(sessionId: string): boolean {
  return deleted.has(sessionId);
}
