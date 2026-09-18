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
   *
   * ## 为什么"没有事件"时必须返回空串（第 45 轮功能上下文审计 P1-D1）
   *
   * 这里的数字全部来自**事件日志的投影**（`getEventProjection().projectSurface`），
   * 而 `EventLog.readAll` 在"该会话的事件镜像还没加载完"时**刻意返回空数组**
   * （`event-log.ts:511` 的门控：宁可说"没有"也不回退旧库，避免读写分裂）。
   *
   * 于是 `totalEvents === 0` 有两种完全不同的含义：
   * ① 这个会话确实没有事件；② **我不知道**（镜像未就绪 / 引擎刚起来）。
   * 原来的实现把两者都当成"事实"，照样拼出 `[Context: 0 visible messages]` 塞进系统提示词
   * —— 模型于是拿到一句**与事实相反**的自我描述（它明明看得见一整段对话，却被告知 0 条）。
   *
   * 正确处置：没有事件就**什么都不说**。注入元信息的价值来自"准确"，
   * 一句不确定的数字比没有这句话更糟（模型会据此低估自己掌握的上下文）。
   */
  buildSurfaceNotice(sessionId: string): string {
    const state = this.getSurfaceState(sessionId);

    // 见上：空的读结果 = "未知"，不是 "0 条" —— 不注入任何结论
    if (state.totalEvents === 0) return "";

    const parts: string[] = [];

    parts.push(`Context: ${state.visibleMessageCount} visible messages`);

    if (state.compactedMessageCount > 0) {
      parts.push(`${state.compactedMessageCount} compacted`);
    }

    parts.push(`${state.totalEvents} total events`);

    const summary = parts.join(", ");
    return `[${summary}]`;
  }

  /**
   * ⚠️ 第 61 轮：这里原来有个 `hasEventLog(sessionId)` = `getEventLog().count(sessionId) > 0`，
   * **已删除**（删除时的核查：全仓零调用者，只有它自己的定义）。
   *
   * 删它的理由不只是"没人用"，而是**名字承诺了一个它在加载窗口里给不出的事实**：
   * `count` 走的是同一条读路由 —— 该会话的事件镜像没加载完时返回 0，
   * 于是 `hasEventLog` 会对一个**有上千条事件**的会话回答 `false`。
   * 真正需要这个判断的调用方要的是"读得到吗"（`isSessionEventsReadable`），
   * 而不是"数了一下是 0" —— 留着这个布尔口子，下一个人就会踩同一颗雷
   * （第 60 轮那个 934/749 就是这么来的）。
   */
}

// ========== Singleton ==========

let surfaceManagerInstance: SurfaceManager | null = null;

export function getSurfaceManager(): SurfaceManager {
  if (!surfaceManagerInstance) {
    surfaceManagerInstance = new SurfaceManager();
  }
  return surfaceManagerInstance;
}
