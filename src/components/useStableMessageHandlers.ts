/**
 * 给**每一行消息**发一个稳定引用的回调（第 233 轮审计 · P1 流式卡顿）。
 *
 * ## 为什么需要它
 *
 * `MessageBubble` 是 `memo()` 的，但 ChatPanel 原来这样传：
 *
 * ```tsx
 * <MessageBubble onDeleteFiles={(files) => handleDeleteFiles(msg.id, files)} />
 * ```
 *
 * 箭头函数**每次渲染都是新引用** ⇒ `memo` 的浅比较永远不相等 ⇒ 流式期间
 * （每 100ms 一次 flush）**整列消息都重渲染**，而实际上只有最后一行在变。
 *
 * ## 做法：按 id 缓存 + ref 转发最新的实现
 *
 * - 每个 id 只创建一次函数，之后**永远返回同一个引用**；
 * - 实现内部通过 ref 调用**最新的** handler（所以 handler 换了闭包变量也不会失效，
 *   也就不会因为依赖变化把整批引用重新生成）。
 *
 * 判据：`chat-streaming-suffix.test.tsx` 的 STREAM-4。
 */
import { useCallback, useRef } from "react";

export type MessageFilesHandler<F> = (id: string, files: F) => void;

export function useStableMessageHandlers<F>(
  handler: MessageFilesHandler<F>,
  ids?: readonly string[],
): (id: string) => (files: F) => void {
  /** 永远指向最新实现（避免把 handler 放进 useCallback 依赖里） */
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  /** id → 稳定函数（同一 id 只建一次） */
  const cacheRef = useRef(new Map<string, (files: F) => void>());

  /**
   * 记一下本次渲染里出现过的 id（清理不再使用的缓存，避免长会话里无限增长）。
   * 只在调用方给了 `ids` 时做 —— 没给就保持原样（保守）。
   */
  const seenRef = useRef<Set<string> | null>(null);
  if (ids) {
    seenRef.current = new Set(ids);
    for (const key of cacheRef.current.keys()) {
      if (!seenRef.current.has(key)) cacheRef.current.delete(key);
    }
  }

  return useCallback((id: string) => {
    const cache = cacheRef.current;
    let fn = cache.get(id);
    if (!fn) {
      fn = (files: F) => handlerRef.current(id, files);
      cache.set(id, fn);
    }
    return fn;
  }, []);
}
