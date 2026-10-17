/**
 * In-memory FIFO guidance queue for mid-turn message injection.
 *
 * Allows users to send steering messages while the agentic loop is running.
 * Messages are consumed at iteration boundaries (before each LLM call),
 * never during tool execution or subagent waiting — ensuring the message
 * chain stays intact.
 *
 * ## 可见性契约（2026-10-18 修正）
 *
 * 早期实现把引导消息当成"只给模型看的一次性上下文"（不落库）—— 于是用户在真机上
 * 追加一句话、点「立刻引导」之后**界面上什么都看不到**，刷新更是彻底消失，
 * 用户无法判断追加是否成功；带图片的追加还会因为不落库而**永远到不了模型**
 * （图片块是从落库消息的 `attachments` 转出来的，见 `storage/message.ts` 的
 * `messagesToLLMMessages`）。
 *
 * 现在的契约：**入队即可见、被消费时落库成真实 user 消息**
 * （`agentic-loop` 消费点用 `GUIDANCE_MESSAGE_TEMPLATE` 落库 + 重建消息投影）。
 * 队列本身仍然只活在内存里 —— 它只是"还没被消费"的暂存区，落库发生在消费那一刻。
 * 判据：`GUIDE-VIS-*` / `GUIDE-ATT-*`。
 */

import type { MessageAttachment } from "../../store";

export interface GuidanceItem {
  /** Unique identifier for this guidance item */
  id: string;
  /** The user's guidance message text（可能为空 —— 只追加了附件时） */
  message: string;
  /** Timestamp when the guidance was enqueued */
  timestamp: number;
  /**
   * 随引导一起发送的附件（图片/文件）。
   *
   * 必须随条目一路带到消费点：消费时它们会写进落库消息的 `attachments`，
   * 图片再由 `messagesToLLMMessages` 转成 image block 交给模型。
   * 早期只传文本参数，附件在这里被静默丢弃 —— 那就是"模型说没看到图片"的根因。
   */
  attachments?: MessageAttachment[];
}

/**
 * Per-session guidance queue.
 *
 * Design:
 * - Each session has its own FIFO queue (array).
 * - `consume()` pops one item per call — the loop calls it once per iteration.
 * - `expire()` clears remaining items when the turn ends.
 * - Thread-safe for single-threaded async usage (JS event loop guarantees
 *   no true parallelism, so no locks needed).
 */
export class GuidanceQueue {
  private queues = new Map<string, GuidanceItem[]>();
  private idCounter = 0;

  /**
   * Enqueue a guidance message for the given session.
   * Called externally (e.g., from the UI) when the user sends a mid-turn message.
   */
  enqueue(sessionId: string, message: string, attachments?: MessageAttachment[]): GuidanceItem {
    return this.push(sessionId, message, attachments, "back");
  }

  /**
   * Enqueue a high-priority guidance message — inserted at the front
   * of the queue so it's consumed first at the next iteration boundary.
   */
  enqueuePriority(sessionId: string, message: string, attachments?: MessageAttachment[]): GuidanceItem {
    return this.push(sessionId, message, attachments, "front");
  }

  /**
   * 入队的唯一实现（back/front 只差插入位置）。
   *
   * 空文本**只有在带附件时才允许**：用户可能只想追加一张图。
   */
  private push(
    sessionId: string,
    message: string,
    attachments: MessageAttachment[] | undefined,
    where: "back" | "front",
  ): GuidanceItem {
    const text = (message ?? "").trim();
    const files = Array.isArray(attachments) && attachments.length > 0 ? attachments : undefined;
    if (!text && !files) {
      throw new Error("Guidance message cannot be empty");
    }

    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }

    const item: GuidanceItem = {
      id: `guide-${Date.now()}-${this.idCounter++}`,
      message: text,
      timestamp: Date.now(),
      ...(files ? { attachments: files } : {}),
    };

    if (where === "front") queue.unshift(item);
    else queue.push(item);
    console.log(
      `[GuidanceQueue] Enqueued${where === "front" ? " (priority)" : ""} for session ${sessionId}: id=${item.id}, ` +
        `msg="${text.substring(0, 80)}...", attachments=${item.attachments?.length ?? 0}, ` +
        `queue_size=${queue.length}`,
    );
    return item;
  }

  /**
   * Consume (pop) the oldest guidance item for this session.
   * Called by the agentic loop at each iteration boundary.
   * Returns null if the queue is empty.
   */
  consume(sessionId: string): GuidanceItem | null {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return null;
    }

    const item = queue.shift()!;
    console.log(
      `[GuidanceQueue] Consumed for session ${sessionId}: id=${item.id}, ` +
        `remaining=${queue.length}`,
    );

    // Clean up empty queues to prevent memory leaks
    if (queue.length === 0) {
      this.queues.delete(sessionId);
    }

    return item;
  }

  /**
   * Peek at the oldest guidance item without removing it.
   * Used to check if guidance is pending before consuming.
   */
  peek(sessionId: string): GuidanceItem | null {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return null;
    }
    return queue[0];
  }

  /**
   * Get the number of pending guidance items for a session.
   */
  pendingCount(sessionId: string): number {
    const queue = this.queues.get(sessionId);
    return queue ? queue.length : 0;
  }

  /**
   * Check if there are pending guidance items for a session.
   */
  hasPending(sessionId: string): boolean {
    return this.pendingCount(sessionId) > 0;
  }

  /**
   * Take **all** pending guidance items for a session (FIFO) and empty the queue.
   *
   * 与 `expire()` 的区别只有返回值：`expire()` 只给出 id（调用方拿不到文本，
   * 因此**没法把没被消费的消息救回来**），`drain()` 把条目本身交出来。
   * 第 ? 波：`agentic-loop.run()` 在回合开始时用 `drain()` 接管上一轮的残留，
   * 把每一条**落库成真实 user 消息**并 `yield guidance_received` ——
   * 「用户发了但模型没看到」不再可能静默发生（见那边的注释）。
   */
  drain(sessionId: string): GuidanceItem[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return [];
    }

    const items = queue.slice();
    this.queues.delete(sessionId);

    console.log(
      `[GuidanceQueue] Drained ${items.length} item(s) for session ${sessionId}`,
    );
    return items;
  }

  /**
   * Expire (discard) all pending guidance items for a session.
   * Returns the IDs of expired items for UI cleanup.
   *
   * ⚠️ 文档此前写的是「Called when the agentic loop finishes」，与真实调用点不符：
   * 它唯一的调用点是 `agentic-loop.run()` 的**开头**（接管上一轮的残留）。
   * 现在那条路径改走 `drain()`（把消息救回来），本方法只保留给
   * 「确实要丢弃」的调用方和既有测试（`core-guidance-pause-resume.test.ts`）。
   */
  expire(sessionId: string): string[] {
    const items = this.drain(sessionId);
    return items.map((item) => item.id);
  }

  /**
   * Clear all sessions' queues. Used for global reset/cleanup.
   */
  clearAll(): void {
    this.queues.clear();
  }
}

/**
 * Global singleton instance.
 * Desktop app — single process, so a global instance is sufficient.
 */
let globalInstance: GuidanceQueue | null = null;

export function getGuidanceQueue(): GuidanceQueue {
  if (!globalInstance) {
    globalInstance = new GuidanceQueue();
  }
  return globalInstance;
}

/**
 * Template for the guidance message injected into LLM input.
 *
 * The message is wrapped in a clear marker so the model understands
 * this is a real-time steering instruction, not a normal chat message
 * to display or respond to formally.
 */
export const GUIDANCE_MESSAGE_TEMPLATE = (
  message: string,
) =>
  `[Runtime guidance from the user]\n` +
  `Use this as an in-progress instruction for the current run. ` +
  `Do not treat it as a normal chat message to display.\n\n` +
  `${message}`;
