/**
 * SurfaceManager — Surface 层管理
 *
 * 设计对标 DSH 的 Surface 概念。
 *
 * Surface = 当前模型可见的消息集合。
 *
 * 在 Event Sourcing 架构中，事件日志是完整的（不可变），
 * 但模型在每轮只看到 "surface" — 即投影后的消息。
 * 压缩事件会移除旧消息并替换为摘要。
 *
 * SurfaceManager 负责跟踪：
 * - 哪些消息当前可见（未被压缩移除）
 * - 哪些消息被压缩移除了
 * - 最后处理的事件序列号
 * - Surface 变化通知（注入到系统提示词）
 *
 * 模型体验：
 * 系统提示词中注入一行简短信息，让模型知道上下文窗口的状态：
 * "Context window: N messages visible, M messages compacted (summary available)."
 */

import { getEventProjection } from "../storage/event-projection";
import { getEventLog } from "../storage/event-log";

// ========== Surface State ==========

export interface SurfaceState {
  /** 当前可见的消息数 */
  visibleMessageCount: number;
  /** 被压缩移除的消息数 */
  compactedMessageCount: number;
  /** 总事件数 */
  totalEvents: number;
  /** 最后处理的序列号 */
  lastSeq: number;
  /** 是否有压缩摘要可用 */
  hasCompactionSummary: boolean;
}

// ========== Surface Manager ==========

export class SurfaceManager {
  /**
   * 获取会话的当前 surface 状态。
   */
  getSurfaceState(sessionId: string): SurfaceState {
    const surface = getEventProjection().projectSurface(sessionId);
    const hasSummary = surface.messages.some(
      (m) => m.id === "compaction-summary",
    );

    return {
      visibleMessageCount: surface.messages.length,
      compactedMessageCount: surface.compactedMessageIds.length,
      totalEvents: surface.totalEvents,
      lastSeq: surface.lastSeq,
      hasCompactionSummary: hasSummary,
    };
  }

  /**
   * 构建一个简短的 surface 状态描述，注入到系统提示词。
   *
   * 对标 DSH 的 surface visibility 注入。
   * 让模型知道当前上下文窗口的状态。
   */
  buildSurfaceNotice(sessionId: string): string {
    const state = this.getSurfaceState(sessionId);

    const parts: string[] = [];

    parts.push(`Context: ${state.visibleMessageCount} visible messages`);

    if (state.compactedMessageCount > 0) {
      parts.push(`${state.compactedMessageCount} compacted`);
    }

    if (state.totalEvents > 0) {
      parts.push(`${state.totalEvents} total events`);
    }

    const summary = parts.join(", ");
    return `[${summary}]`;
  }

  /**
   * 检查会话是否有事件日志（是否已初始化）。
   */
  hasEventLog(sessionId: string): boolean {
    return getEventLog().count(sessionId) > 0;
  }
}

// ========== Singleton ==========

let surfaceManagerInstance: SurfaceManager | null = null;

export function getSurfaceManager(): SurfaceManager {
  if (!surfaceManagerInstance) {
    surfaceManagerInstance = new SurfaceManager();
  }
  return surfaceManagerInstance;
}
