/**
 * SessionMessageBus — 跨会话事件总线
 *
 * 提供基于 EventEmitter 模式的会话间通信能力。
 * 每个会话可以订阅自己的消息频道，其他会话通过 send() 向目标频道发消息。
 *
 * 设计原则：
 * - 单例模式，全局唯一总线
 * - 内存级别，不持久化消息本身（委派任务由 DelegationStorage 持久化）
 * - 支持通配符订阅（"*" 接收所有消息，用于 UI 全局监听）
 *
 * 使用模式（参考 pet-store.ts 的 Tauri 事件模式）：
 *   const bus = getSessionMessageBus();
 *   const unsub = bus.subscribe("session-B", (msg) => { ... });
 *   bus.send("session-B", { type: "delegation", task: "设计 XXX", ... });
 *   unsub(); // 清理
 */

import type { SessionMessage } from "./types";

type MessageListener = (message: SessionMessage) => void;

export class SessionMessageBus {
  /** 按 sessionId 分组的监听器 */
  private listeners: Map<string, Set<MessageListener>> = new Map();
  /** 通配符监听器（接收所有消息，用于 UI 全局展示） */
  private globalListeners: Set<MessageListener> = new Set();
  /** 消息历史（环形缓冲，最近 100 条，用于调试和新订阅者回放） */
  private history: SessionMessage[] = [];
  private readonly historyMax = 100;

  /**
   * 向目标会话发送消息。
   * 同步分发——监听器在当前调用栈内执行。
   */
  send(targetSessionId: string, message: Omit<SessionMessage, "id" | "timestamp" | "targetSessionId"> & { targetSessionId?: string }): string {
    const fullMessage: SessionMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      targetSessionId: message.targetSessionId || targetSessionId,
      timestamp: Date.now(),
    };

    // 记录到历史
    this.history.push(fullMessage);
    if (this.history.length > this.historyMax) {
      this.history.shift();
    }

    // 分发给目标会话的监听器
    const sessionListeners = this.listeners.get(targetSessionId);
    if (sessionListeners) {
      for (const listener of sessionListeners) {
        try {
          listener(fullMessage);
        } catch (e) {
          console.error("[SessionMessageBus] Listener error:", e);
        }
      }
    }

    // 分发给全局监听器
    for (const listener of this.globalListeners) {
      try {
        listener(fullMessage);
      } catch (e) {
        console.error("[SessionMessageBus] Global listener error:", e);
      }
    }

    console.log(`[SessionMessageBus] ${fullMessage.type}: ${fullMessage.sourceSessionId} → ${fullMessage.targetSessionId}`);
    return fullMessage.id;
  }

  /**
   * 向所有会话广播消息。
   */
  broadcast(message: Omit<SessionMessage, "id" | "timestamp" | "targetSessionId">): string {
    const fullMessage: SessionMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      targetSessionId: "*",
      timestamp: Date.now(),
    };

    this.history.push(fullMessage);
    if (this.history.length > this.historyMax) {
      this.history.shift();
    }

    // 分发给所有会话的监听器
    for (const [, listeners] of this.listeners) {
      for (const listener of listeners) {
        try {
          listener(fullMessage);
        } catch (e) {
          console.error("[SessionMessageBus] Broadcast listener error:", e);
        }
      }
    }

    // 分发给全局监听器
    for (const listener of this.globalListeners) {
      try {
        listener(fullMessage);
      } catch (e) {
        console.error("[SessionMessageBus] Broadcast global listener error:", e);
      }
    }

    return fullMessage.id;
  }

  /**
   * 订阅指定会话的消息。
   * 返回取消订阅函数。
   */
  subscribe(sessionId: string, listener: MessageListener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(listener);

    return () => {
      const set = this.listeners.get(sessionId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(sessionId);
        }
      }
    };
  }

  /**
   * 订阅所有会话的消息（通配符）。
   * 用于 UI 层全局展示跨会话活动。
   * 返回取消订阅函数。
   */
  subscribeAll(listener: MessageListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * 获取消息历史（最近 N 条）。
   * 可选过滤指定会话的消息。
   */
  getHistory(sessionId?: string): SessionMessage[] {
    if (!sessionId) return [...this.history];
    return this.history.filter(
      (m) => m.sourceSessionId === sessionId || m.targetSessionId === sessionId,
    );
  }

  /** 清空历史（用于测试或重置） */
  clearHistory(): void {
    this.history = [];
  }
}

// ========== 单例 ==========

let busInstance: SessionMessageBus | null = null;

export function getSessionMessageBus(): SessionMessageBus {
  if (!busInstance) {
    busInstance = new SessionMessageBus();
  }
  return busInstance;
}

/** 重置单例（仅用于测试） */
export function resetSessionMessageBus(): void {
  busInstance = null;
}
