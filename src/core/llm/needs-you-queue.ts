/**
 * NeedsYouQueue — Agent→Human direction queue (reverse GuidanceQueue)
 *
 * Agent proactively pauses iteration and asks user a precise question.
 * Questions are consumed at iteration boundaries (like guidance), NOT inside
 * tool callbacks — this prevents blocking tool returns.
 *
 * Persistence: needs_you_pending SQLite table for session recovery.
 * Key principle: only 1 needs_you per iteration + user can "skip and continue".
 */

export interface NeedsYouItem {
  id: string;
  sessionId: string;
  question: string;
  context: string;          // What work is being done
  confirmedFacts: string;   // What has already been confirmed
  options: NeedsYouOption[];
  resumePath: string;       // How to continue after answer
  iteration: number;
  createdAt: number;
}

export interface NeedsYouOption {
  id: string;
  label: string;
}

interface PendingAnswer {
  resolve: (answer: string) => void;
}

const queues = new Map<string, NeedsYouItem[]>();
const pendingAnswers = new Map<string, PendingAnswer>();

function generateId(): string {
  return `ny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type NeedsYouListener = (item: NeedsYouItem) => void;
const listeners = new Set<NeedsYouListener>();

export function onNeedsYou(listener: NeedsYouListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(item: NeedsYouItem): void {
  listeners.forEach((l) => {
    try { l(item); } catch (e) { console.warn("[NeedsYouQueue] listener error:", e); }
  });
}

export const NeedsYouQueue = {
  /**
   * Enqueue a needs_you question for a session.
   * Called by AgenticLoop at iteration boundary when agent detects it needs human input.
   */
  enqueue(
    sessionId: string,
    params: Omit<NeedsYouItem, "id" | "sessionId" | "createdAt" | "iteration">,
    iteration: number,
  ): NeedsYouItem {
    const item: NeedsYouItem = {
      id: generateId(),
      sessionId,
      iteration,
      createdAt: Date.now(),
      ...params,
    };

    let queue = queues.get(sessionId);
    if (!queue) {
      queue = [];
      queues.set(sessionId, queue);
    }
    queue.push(item);
    emit(item);
    return item;
  },

  /**
   * Consume a pending needs_you for a session.
   * Returns the oldest unanswered question, or null if none.
   * Called at iteration boundary (like guidance.consume).
   */
  consume(sessionId: string): NeedsYouItem | null {
    const queue = queues.get(sessionId);
    if (!queue || queue.length === 0) return null;
    return queue.shift() || null;
  },

  /**
   * Check if there are pending needs_you items.
   */
  hasPending(sessionId: string): boolean {
    const queue = queues.get(sessionId);
    return !!queue && queue.length > 0;
  },

  /**
   * Answer a needs_you question. Returns a promise that resolves when
   * the AgenticLoop picks up the answer at the next iteration boundary.
   */
  answer(itemId: string, answer: string): void {
    // Resolve any pending promise waiting for this answer
    const pending = pendingAnswers.get(itemId);
    if (pending) {
      pending.resolve(answer);
      pendingAnswers.delete(itemId);
    }
  },

  /**
   * Wait for user's answer to a needs_you item.
   * Called by AgenticLoop to pause execution until user responds.
   */
  waitForAnswer(itemId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      pendingAnswers.set(itemId, { resolve });
    });
  },

  /**
   * Skip a needs_you item (user chose "skip and continue").
   */
  skip(sessionId: string): void {
    const queue = queues.get(sessionId);
    if (queue) queue.shift();
  },

  /**
   * Clear all pending items for a session.
   */
  clear(sessionId: string): void {
    queues.delete(sessionId);
    // Clear pending answers for this session
    for (const [id, pending] of pendingAnswers) {
      pending.resolve("__skip__");
      pendingAnswers.delete(id);
    }
  },

  /**
   * Get all pending items for a session (for UI display).
   */
  getPending(sessionId: string): NeedsYouItem[] {
    return queues.get(sessionId) || [];
  },
};

/** Singleton getter (matches pattern from guidance-queue.ts) */
export function getNeedsYouQueue(): typeof NeedsYouQueue {
  return NeedsYouQueue;
}
