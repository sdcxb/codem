/**
 * Flashcard 存储与 SM-2 间隔重复算法
 *
 * 借鉴 Lumina Note 的闪卡功能, 自研实现:
 * - SQLite 持久化闪卡数据
 * - SM-2 算法管理复习间隔
 * - 支持从笔记内容 AI 生成闪卡
 */

import { getDatabase } from '../storage/database';
import { runGuarded } from "../storage/write-guard";
import {
  domainDelete,
  domainDeleteWhere,
  domainReadMany,
  domainReadOne,
  domainWrite,
  shouldFallbackToLegacy,
  writeShouldFallBackToLegacy,
} from "../storage/domain-store";

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
  /*
   * B 态（端口在、镜像未就绪）：不写旧库，如实上报并返回已构造的对象
   * （镜像里那份是有效的，与上面"读回来的那一份"语义一致）。
   */
  if (!writeShouldFallBackToLegacy("flashcard.create", "闪卡未保存")) return created;
  const db = getDatabase();
  db.run(
    `INSERT INTO flashcards (id, notebook_id, note_id, front, back, tags, ease_factor, interval_days, repetitions, next_review, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 2.5, 0, 0, ?, ?, ?)`,
    [id, input.notebookId, input.noteId || null, input.front, input.back,
     input.tags ? JSON.stringify(input.tags) : null, now, now, now]
  );

  return getFlashcard(id)!;
}

export function getFlashcard(id: string): Flashcard | undefined {
  const rust = domainReadOne(TABLE, { id }, wireToFlashcard);
  if (rust !== undefined) return rust ?? undefined;
    if (!shouldFallbackToLegacy()) return undefined;
const db = getDatabase();
  const result = db.exec('SELECT * FROM flashcards WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return undefined;
  return rowToFlashcard(result[0].values[0]);
}

export function listFlashcards(notebookId: string): Flashcard[] {
  const rust = readFlashcards({ notebook_id: notebookId });
  if (rust) return rust.sort(bySchedule);
    if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE notebook_id = ? ORDER BY next_review ASC, created_at DESC',
    [notebookId]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
}

// C5: 按笔记 ID 列出闪卡 — 支持从特定笔记生成和管理闪卡
export function listFlashcardsByNote(noteId: string): Flashcard[] {
  const rust = readFlashcards({ note_id: noteId });
  if (rust) return rust.sort(bySchedule);
    if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE note_id = ? ORDER BY next_review ASC, created_at DESC',
    [noteId]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
}

export function getDueFlashcards(notebookId: string): Flashcard[] {
  const now = Date.now();
  const rust = readFlashcards({ notebook_id: notebookId });
  if (rust) {
    return rust.filter((c) => c.nextReview <= now).sort((a, b) => a.nextReview - b.nextReview);
  }
    if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE notebook_id = ? AND next_review <= ? ORDER BY next_review ASC',
    [notebookId, now]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
}

// C5: 按笔记 ID 获取待复习闪卡
export function getDueFlashcardsByNote(noteId: string): Flashcard[] {
  const now = Date.now();
  const rust = readFlashcards({ note_id: noteId });
  if (rust) {
    return rust.filter((c) => c.nextReview <= now).sort((a, b) => a.nextReview - b.nextReview);
  }
    if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE note_id = ? AND next_review <= ? ORDER BY next_review ASC',
    [noteId, now]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
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

    if (!writeShouldFallBackToLegacy("flashcard.update", "卡片未更新")) return;
const db = getDatabase();
  const values: (string | number | null)[] = [];
  if (update.front !== undefined) values.push(update.front);
  if (update.back !== undefined) values.push(update.back);
  if (update.tags !== undefined) values.push(JSON.stringify(update.tags));
  values.push(Date.now());
  values.push(id);

  runGuarded(
    db,
    `UPDATE flashcards SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    values,
    { table: "flashcards", op: "update", id, from: "updateFlashcard" },
  );
}

export function deleteFlashcard(id: string): void {
  if (domainDelete(TABLE, { id }, { scope: "flashcard.delete", note: "闪卡未删除" })) return;
    if (!writeShouldFallBackToLegacy("flashcard.delete", "卡片未删除")) return;
const db = getDatabase();
  db.run('DELETE FROM flashcards WHERE id = ?', [id]);
}

export function deleteFlashcardsByNotebook(notebookId: string): void {
  const removed = domainDeleteWhere(
    TABLE,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "flashcard.deleteByNotebook", note: "笔记本的闪卡未删除" },
  );
  if (removed !== null) return;
    if (!writeShouldFallBackToLegacy("flashcard.deleteByNotebook", "卡片未删除")) return;
const db = getDatabase();
  db.run('DELETE FROM flashcards WHERE notebook_id = ?', [notebookId]);
}

// ========== SM-2 Spaced Repetition Algorithm ==========

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * SM-2 algorithm: update flashcard scheduling based on review rating
 */
export function reviewFlashcard(id: string, rating: ReviewRating): void {
  const card = getFlashcard(id);
  if (!card) return;

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

  // 迁移期：整体写回（调度四元组 + updated_at）。未接手时继续走旧库。
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

    if (!writeShouldFallBackToLegacy("flashcard.review", "复习记录未保存")) return;
const db = getDatabase();
  db.run(
    `UPDATE flashcards SET ease_factor = ?, interval_days = ?, repetitions = ?, next_review = ?, updated_at = ? WHERE id = ?`,
    [easeFactor, intervalDays, repetitions, nextReview, now, id]
  );
}

// ========== Helpers ==========

function rowToFlashcard(row: any[]): Flashcard {
  return {
    id: row[0] as string,
    notebookId: row[1] as string,
    noteId: row[2] as string || undefined,
    front: row[3] as string,
    back: row[4] as string,
    tags: row[5] ? JSON.parse(row[5] as string) : undefined,
    easeFactor: row[6] as number,
    intervalDays: row[7] as number,
    repetitions: row[8] as number,
    nextReview: row[9] as number,
    createdAt: row[10] as number,
    updatedAt: row[11] as number,
  };
}