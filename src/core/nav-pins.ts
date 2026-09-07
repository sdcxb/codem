/**
 * nav-pins — 消息精选 pin（对标 dsh-navbar 的 📌 精选功能）
 *
 * 用户可以把某条 assistant 回复"精选"（pin）到右侧导航条：
 * - 精选的 assistant 消息在 ScrollbarMarkers 中渲染为金色圆盘（恒可见）
 * - 状态按会话持久化到 localStorage（与 EAC dsh-navbar:pins:<sid> 同构，
 *   轻量无 DB 迁移成本）
 */

const KEY_PREFIX = "codem-navbar:pins:";

function safeParse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 读取某会话已精选的消息 id 列表 */
export function listPinnedIds(sessionId: string): string[] {
  try {
    return safeParse(localStorage.getItem(KEY_PREFIX + sessionId));
  } catch {
    return [];
  }
}

/** 某消息是否已精选 */
export function isPinned(sessionId: string, messageId: string): boolean {
  return listPinnedIds(sessionId).includes(messageId);
}

/** 精选 / 取消精选，返回更新后的列表 */
export function togglePin(sessionId: string, messageId: string): string[] {
  const cur = listPinnedIds(sessionId);
  const next = cur.includes(messageId) ? cur.filter((id) => id !== messageId) : [...cur, messageId];
  try {
    localStorage.setItem(KEY_PREFIX + sessionId, JSON.stringify(next));
  } catch {
    /* storage unavailable — no-op */
  }
  return next;
}

/** 清空某会话全部精选 */
export function clearPins(sessionId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    /* no-op */
  }
}

/** 订阅某会话精选变化（跨组件同步：MessageBubble ↔ ScrollbarMarkers） */
export function subscribePins(sessionId: string, cb: (ids: string[]) => void): () => void {
  const listener = () => cb(listPinnedIds(sessionId));
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
