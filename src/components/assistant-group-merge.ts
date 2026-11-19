/**
 * 合并连续 assistant 消息为**一个**可渲染对象（ChatPanel 的「统一模式」气泡）。
 *
 * ## 为什么要抽出来 + 缓存
 *
 * 原来这段逻辑写在 ChatPanel 的渲染体里，每次渲染都新建一个 `merged` 对象：
 * `{ ...msg, content: 各段拼接, toolCalls: flatMap, status: 最后一条的状态, … }`。
 *
 * 而 `MessageBubble` 是 `memo` 组件、按浅比较判断 props 是否变化 ——
 * **每次渲染都判定"变了"**，于是整列 assistant 气泡被迫重渲染：react-markdown 重新解析、
 * `autoLinkFilePaths` 全文重扫、工具参数重新 `JSON.stringify(…, null, 2)`。
 * 流式期每秒约 20 次渲染（10 次 flush + 10 次滚动），长会话直接卡。
 *
 * 缓存键用「组内 id 序列 + 各段长度 + 状态 + 工具数 + 生成文件数 + 思考长度」：
 * - 用长度而不是正文，避免为了算键再拼一遍大字符串（那等于没优化）；
 * - 内容没变就复用同一个对象引用 ⇒ memo 生效；
 * - 内容/状态变了自然换键 ⇒ 界面照样更新（不会拿旧内容糊弄）。
 *
 * 缓存上限 240 组：流式期间每次 flush 都会产生新键，旧键必须及时丢（长会话内存）。
 */

import type { Message } from "../store";

const CACHE_LIMIT = 240;

const cache = new Map<string, Message>();

/** 只给测试用：清空缓存，让用例之间互不影响 */
export function resetAssistantGroupCache(): void {
  cache.clear();
}

function groupKey(group: Message[]): string {
  const last = group[group.length - 1];
  let toolCount = 0;
  let fileCount = 0;
  let reasoningChars = 0;
  let firstContentChars = 0;
  for (let i = 0; i < group.length; i++) {
    const m = group[i];
    toolCount += m.toolCalls?.length ?? 0;
    fileCount += m.generatedFiles?.length ?? 0;
    reasoningChars += m.reasoning?.length ?? 0;
    if (i === 0) firstContentChars = m.content?.length ?? 0;
  }
  return (
    group.map((m) => m.id).join("|") +
    `#${firstContentChars},${last.content?.length ?? 0},${last.status ?? ""},${toolCount},${fileCount},${reasoningChars}`
  );
}

/**
 * 合并一组连续 assistant 消息。同内容返回同一引用（memo 友好）。
 *
 * 组里只有一条时**直接返回原对象**（最常见的情况，零分配）。
 */
export function mergeAssistantGroup(group: Message[]): Message {
  if (group.length === 0) throw new Error("mergeAssistantGroup: 空组");
  if (group.length === 1) return group[0];
  const key = groupKey(group);
  const hit = cache.get(key);
  if (hit) return hit;
  const first = group[0];
  const last = group[group.length - 1];
  const merged: Message = {
    ...first,
    id: first.id, // 保留组内第一条的 id（后续滚动定位/锚点都按它）
    content: group.map((m) => m.content).filter(Boolean).join("\n\n---\n\n"),
    reasoning: group.map((m) => m.reasoning).filter(Boolean).join("\n\n---\n\n") || undefined,
    toolCalls: group.flatMap((m) => m.toolCalls || []),
    status: last.status,
    generatedFiles:
      group.flatMap((m) => m.generatedFiles || []).length > 0
        ? group.flatMap((m) => m.generatedFiles || [])
        : undefined,
  };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, merged);
  return merged;
}
