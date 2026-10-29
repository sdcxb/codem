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

import {
  deletePendingRow,
  loadPendingRows,
  onPendingPersistenceReady,
  isPendingPersistenceAvailable,
  upsertPendingRow,
} from "./pending-persistence";

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
    /**
     * 2026-10-29：落库（表早就有，之前只写内存）。
     * 异步写穿：失败只记日志，不阻断回合；重启后由 `hydrateNeedsYouFromStorage()` 回填。
     */
    void upsertPendingRow("needs_you_pending", {
      id: item.id,
      session_id: item.sessionId,
      question: item.question,
      context: item.context,
      confirmed_facts: item.confirmedFacts,
      options: JSON.stringify(item.options),
      resume_path: item.resumePath,
      iteration: item.iteration,
      created_at: item.createdAt,
    });
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
    const item = queue.shift() || null;
    if (item) void deletePendingRow("needs_you_pending", item.id);
    return item;
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
    // 已回答 = 该条不再需要跨重启保留
    void deletePendingRow("needs_you_pending", itemId);
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
    const item = queue?.shift();
    if (item) void deletePendingRow("needs_you_pending", item.id);
  },

  /**
   * Clear all pending items for a session.
   */
  clear(sessionId: string): void {
    const dropped = queues.get(sessionId) ?? [];
    queues.delete(sessionId);
    for (const item of dropped) void deletePendingRow("needs_you_pending", item.id);
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

/**
 * 从 SQLite 回填待处理问题（重启恢复）。
 *
 * 语义边界：重启后**没有**等待中的 `waitForAnswer` promise（那个回合已经结束），
 * 所以回填只负责"让问题重新可见、可回答"；回答后按销账处理，不假装能恢复旧回合。
 */
let needsYouHydrated = false;

export async function hydrateNeedsYouFromStorage(): Promise<number> {
  if (needsYouHydrated) return 0;
  needsYouHydrated = true;
  const rows = await loadPendingRows("needs_you_pending");
  let added = 0;
  for (const row of rows) {
    const id = String(row.id ?? "");
    if (!id) continue;
    const sessionId = String(row.session_id ?? "");
    if (!sessionId) continue;
    const queue = queues.get(sessionId) ?? [];
    if (queue.some((x) => x.id === id)) continue;
    let options: NeedsYouOption[] = [];
    try {
      const parsed = JSON.parse(String(row.options ?? "[]"));
      if (Array.isArray(parsed)) options = parsed;
    } catch {
      /* 坏 options 不阻塞恢复：按空选项展示 */
    }
    queue.push({
      id,
      sessionId,
      question: String(row.question ?? ""),
      context: String(row.context ?? ""),
      confirmedFacts: String(row.confirmed_facts ?? ""),
      options,
      resumePath: String(row.resume_path ?? ""),
      iteration: Number(row.iteration ?? 0),
      createdAt: Number(row.created_at ?? Date.now()),
    });
    queues.set(sessionId, queue);
    added += 1;
  }
  return added;
}

if (isPendingPersistenceAvailable()) void hydrateNeedsYouFromStorage();
onPendingPersistenceReady(() => {
  needsYouHydrated = false;
  void hydrateNeedsYouFromStorage();
});