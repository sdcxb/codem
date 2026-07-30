/**
 * In-memory FIFO guidance queue for mid-turn message injection.
 *
 * Allows users to send steering messages while the agentic loop is running.
 * Messages are consumed at iteration boundaries (before each LLM call),
 * never during tool execution or subagent waiting — ensuring the message
 * chain stays intact.
 *
 * Guided messages are ephemeral: they are appended to the LLM input for
 * one iteration only and are NOT persisted to the message database.
 */

export interface GuidanceItem {
  /** Unique identifier for this guidance item */
  id: string;
  /** The user's guidance message text */
  message: string;
  /** Timestamp when the guidance was enqueued */
  timestamp: number;
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
  enqueue(sessionId: string, message: string): GuidanceItem {
    if (!message.trim()) {
      throw new Error("Guidance message cannot be empty");
    }

    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }

    const item: GuidanceItem = {
      id: `guide-${Date.now()}-${this.idCounter++}`,
      message: message.trim(),
      timestamp: Date.now(),
    };

    queue.push(item);
    console.log(
      `[GuidanceQueue] Enqueued for session ${sessionId}: id=${item.id}, ` +
        `msg="${message.substring(0, 80)}...", ` +
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
   * Expire (discard) all pending guidance items for a session.
   * Called when the agentic loop finishes (normally or via abort).
   * Returns the IDs of expired items for UI cleanup.
   */
  expire(sessionId: string): string[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return [];
    }

    const expiredIds = queue.map((item) => item.id);
    this.queues.delete(sessionId);

    console.log(
      `[GuidanceQueue] Expired ${expiredIds.length} item(s) for session ${sessionId}`,
    );
    return expiredIds;
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
