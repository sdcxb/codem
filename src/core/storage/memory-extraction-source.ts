/**
 * 记忆提取源（P0-1）：**数据层出口**。
 *
 * 提取器要"模型视图 ∪ 完整时间线"里更完整的那个（压缩前的原文最该沉淀成记忆）。
 * 这两个读都是整会话同步读 ⇒ 按 `no-sync-mirror-reads` 的边界，它们只能出现在数据层，
 * 业务层不许自己拿整份时间线。
 *
 * ⚠️ 这里必须用**命名空间属性访问**（`MessageStorage.listMessages(...)`）而不是解构导入：
 * 既有十来个提取判据靠 `vi.spyOn(MessageStorage, "listMessages")` 喂夹具，
 * 解构会把函数引用固定住，spy 就失效了。
 */
import * as MessageStorage from "./message";

/** 提取器本次应该看的消息（有界由调用方按窗口再切） */
export function extractionMessages(sessionId: string): unknown[] {
  return MessageStorage.pickExtractionMessages(
    MessageStorage.listMessages(sessionId),
    MessageStorage.listTimelineMessages(sessionId),
  ) as unknown[];
}
