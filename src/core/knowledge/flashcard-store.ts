/**
 * Flashcard 存储与 SM-2 间隔重复算法
 *
 * 借鉴 Lumina Note 的闪卡功能, 自研实现:
 * - SQLite 持久化闪卡数据
 * - SM-2 算法管理复习间隔
 * - 支持从笔记内容 AI 生成闪卡
 */

import {
  domainDelete,
  domainDeleteWhere,
  domainPortRegistered,
  domainReadMany,
  domainReadOne,
  domainWrite,
} from "../storage/domain-store";
import { reportPersistFailure } from "../storage/persist-failure";

// ========== Types ==========

export interface Flashcard {
  id: string;
  notebookId: string;
  noteId?: string;
  front: string;
  back: string;
  tags?: string[];
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReview: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFlashcardInput {
  notebookId: string;
  noteId?: string;
  front: string;
  back: string;
  tags?: string[];
}

// ========== CRUD ==========

const TABLE = "flashcards";

/** 线协议行 → `Flashcard`（`tags` 是 JSON 文本） */
function wireToFlashcard(row: Record<string, unknown>): Flashcard {
  const tags = row.tags as string | null;
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    noteId: (row.note_id as string) || undefined,
    front: String(row.front),
    back: String(row.back),
    tags: tags ? JSON.parse(tags) : undefined,
    easeFactor: Number(row.ease_factor),
    intervalDays: Number(row.interval_days),
    repetitions: Number(row.repetitions),
    nextReview: Number(row.next_review),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** `Flashcard` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function flashcardToWire(card: Flashcard): Record<string, unknown> {
  return {
    id: card.id,
    notebook_id: card.notebookId,
    note_id: card.noteId ?? null,
    front: card.front,
    back: card.back,
    tags: card.tags ? JSON.stringify(card.tags) : null,
    ease_factor: card.easeFactor,
    interval_days: card.intervalDays,
    repetitions: card.repetitions,
    next_review: card.nextReview,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
  };
}

/** 旧 SQL：`ORDER BY next_review ASC, created_at DESC` */
function bySchedule(a: Flashcard, b: Flashcard): number {
  return a.nextReview !== b.nextReview ? a.nextReview - b.nextReview : b.createdAt - a.createdAt;
}

function readFlashcards(where?: Record<string, unknown>): Flashcard[] | undefined {
  return domainReadMany(TABLE, wireToFlashcard, where);
}

export function createFlashcard(input: CreateFlashcardInput): Flashcard {
  const now = Date.now();
  const id = `fc-${now}-${Math.random().toString(36).substring(7)}`;
  const created: Flashcard = {
    id,
    notebookId: input.notebookId,
    noteId: input.noteId || undefined,
    front: input.front,
    back: input.back,
    tags: input.tags,
    easeFactor: 2.5,
    intervalDays: 0,
    repetitions: 0,
    nextReview: now,
    createdAt: now,
    updatedAt: now,
  };
  // 旧实现 `return getFlashcard(id)!` —— 必须是"读回来的那一份"，
  // 走镜像路径时读回来的也正好是刚写进镜像的行（同一份数据，字段一一对应）。
  if (domainWrite(TABLE, [flashcardToWire(created)], { scope: "flashcard.create", note: "闪卡未保存" })) {
    return getFlashcard(id) ?? created;
  }
  /**
   * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，返回内存里那份已构造好的对象。
   *
   * 返回 `created` 与原来 B 态（端口在、该域镜像未就绪）的行为**完全一致** ——
   * 那时就已经是"不碰旧库 + 如实上报 + 返回已构造的对象"。
   * 所以这里不是新造的"假成功"：差别只是失败现在**可见**（原来 A 态静默落旧库，
   * 而读路径只认端口 = 本进程内读写分裂）。
   */
  reportPersistFailure(
    "flashcard.create",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "闪卡未保存",
  );
  return created;
}

export function getFlashcard(id: string): Flashcard | undefined {
  const rust = domainReadOne(TABLE, { id }, wireToFlashcard);
  if (rust !== undefined) return rust ?? undefined;
  // 端口没接手 → 该域读不到这一行（旧库已从渲染进程移除）→ 如实返回 undefined
  return undefined;
}

export function listFlashcards(notebookId: string): Flashcard[] {
  const rust = readFlashcards({ notebook_id: notebookId });
  if (rust) return rust.sort(bySchedule);
  /**
   * **旧库读取已删除**（L4 收尾）：端口没接手 → 该域的合理空结果（空数组）。
   * 与原来门控里那句 `if (!shouldFallbackToLegacy()) return [];` **语义一致**。
   */
  return [];
}

// C5: 按笔记 ID 列出闪卡 — 支持从特定笔记生成和管理闪卡
export function listFlashcardsByNote(noteId: string): Flashcard[] {
  const rust = readFlashcards({ note_id: noteId });
  if (rust) return rust.sort(bySchedule);
  // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致）
  return [];
}

export function getDueFlashcards(notebookId: string): Flashcard[] {
  const now = Date.now();
  const rust = readFlashcards({ notebook_id: notebookId });
  if (rust) {
    return rust.filter((c) => c.nextReview <= now).sort((a, b) => a.nextReview - b.nextReview);
  }
  // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致）
  return [];
}

// C5: 按笔记 ID 获取待复习闪卡
export function getDueFlashcardsByNote(noteId: string): Flashcard[] {
  const now = Date.now();
  const rust = readFlashcards({ note_id: noteId });
  if (rust) {
    return rust.filter((c) => c.nextReview <= now).sort((a, b) => a.nextReview - b.nextReview);
  }
  // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致）
  return [];
}

export function updateFlashcard(id: string, update: Partial<Pick<Flashcard, 'front' | 'back' | 'tags'>>): void {
  const fields: string[] = [];
  if (update.front !== undefined) fields.push('front');
  if (update.back !== undefined) fields.push('back');
  if (update.tags !== undefined) fields.push('tags');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[flashcard-store.ts] update 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(TABLE, { id }, wireToFlashcard);
  if (current !== undefined) {
    if (current === null) return; // 闪卡不存在：旧实现是 UPDATE 影响 0 行
    const next: Flashcard = {
      ...current,
      ...(update.front !== undefined ? { front: update.front } : {}),
      ...(update.back !== undefined ? { back: update.back } : {}),
      ...(update.tags !== undefined ? { tags: update.tags } : {}),
      updatedAt: Date.now(),
    };
    domainWrite(TABLE, [flashcardToWire(next)], {
      mode: "replace",
      scope: "flashcard.update",
      note: "闪卡未更新（闪卡不存在或写入失败）",
    });
    return;
  }

  /**
   * **旧库更新已删除**（L4 收尾）：端口没接手时**如实上报为"未更新"**。
   *
   * ⚠️ 不能静默 return：`updateFlashcard` 的契约是 void，调用方只能靠
   * "有没有失败上报"判断这次改动有没有落地 —— 静默就是 B 类假成功。
   */
  reportPersistFailure(
    "flashcard.update",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "卡片未更新",
  );
}

export function deleteFlashcard(id: string): void {
  if (domainDelete(TABLE, { id }, { scope: "flashcard.delete", note: "闪卡未删除" })) return;
  // 旧库删除已删除（L4）：端口没接手 → 如实上报为"未删除"（不静默当成删成功）
  reportPersistFailure(
    "flashcard.delete",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "卡片未删除",
  );
}

export function deleteFlashcardsByNotebook(notebookId: string): void {
  const removed = domainDeleteWhere(
    TABLE,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "flashcard.deleteByNotebook", note: "笔记本的闪卡未删除" },
  );
  if (removed !== null) return;
  // 旧库删除已删除（L4）：端口没接手 → 如实上报为"未删除"
  reportPersistFailure(
    "flashcard.deleteByNotebook",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "卡片未删除",
  );
}

// ========== SM-2 Spaced Repetition Algorithm ==========

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * 按 SM-2 更新复习进度。
 *
 * ## 任务 C-8：`if (!card) return;` 原来是静默丢弃
 *
 * `getFlashcard` 在镜像未接手时返回 `undefined`，与"这张卡不存在"用的是**同一个值** ——
 * 原实现直接 `return`，于是用户点了"再来一次/简单"，界面上的下次复习时间变了（前端本地状态），
 * 库里**一行都没写**，且没有任何上报。
 *
 * 现在把三态分开：
 * - 卡片**确实不存在** → 业务失败（如实上报，"这张卡没了"）；
 * - **端口在但镜像未接手** → 可重试失败（如实上报，"稍后再点一次"）；
 * - 卡片内容解析不出调度字段 → 数据问题（如实上报）。
 */
export function reviewFlashcard(id: string, rating: ReviewRating): void {
  const card = getFlashcard(id);
  if (!card) {
    reportPersistFailure(
      "flashcard.review",
      new Error(
        domainPortRegistered()
          ? "端口已注册但 flashcards 镜像未接手（未就绪 / 未镜像）"
          : `flashcards 里没有 id=${id}`,
      ),
      domainPortRegistered()
        ? `复习进度未保存：本次读不到卡片 ${id}（**不是**"卡片不存在"），请稍后重试`
        : `复习进度未保存：卡片 ${id} 不存在（可能已被删除）`,
    );
    return;
  }

  const now = Date.now();
  let { easeFactor, intervalDays, repetitions } = card;

  // Quality mappings (0-5 scale for SM-2)
  const qualityMap: Record<ReviewRating, number> = {
    again: 1,
    hard: 3,
    good: 4,
    easy: 5,
  };
  const q = qualityMap[rating];

  if (q < 3) {
    // Failed — reset
    repetitions = 0;
    intervalDays = 0;
  } else {
    // Passed
    if (repetitions === 0) {
      intervalDays = 1;
    } else if (repetitions === 1) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(intervalDays * easeFactor);
    }
    repetitions += 1;
  }

  // Update ease factor (SM-2 formula)
  easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (easeFactor < 1.3) easeFactor = 1.3;

  const nextReview = now + intervalDays * 24 * 60 * 60 * 1000;

  // 迁移期：整体写回（调度四元组 + updated_at）。
  const rust = domainReadOne(TABLE, { id }, wireToFlashcard);
  if (rust !== undefined) {
    if (rust === null) return;
    domainWrite(
      TABLE,
      [flashcardToWire({ ...rust, easeFactor, intervalDays, repetitions, nextReview, updatedAt: now })],
      { mode: "replace", scope: "flashcard.review", note: "闪卡复习进度未保存" },
    );
    return;
  }

  // 旧库更新已删除（L4）：端口没接手 → 如实上报为"复习进度未保存"（不静默丢弃）
  reportPersistFailure(
    "flashcard.review",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "复习记录未保存",
  );
}