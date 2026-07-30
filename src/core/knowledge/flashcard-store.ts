/**
 * Flashcard 存储与 SM-2 间隔重复算法
 *
 * 借鉴 Lumina Note 的闪卡功能, 自研实现:
 * - SQLite 持久化闪卡数据
 * - SM-2 算法管理复习间隔
 * - 支持从笔记内容 AI 生成闪卡
 */

import { getDatabase } from '../storage/database';

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

export function createFlashcard(input: CreateFlashcardInput): Flashcard {
  const db = getDatabase();
  const now = Date.now();
  const id = `fc-${now}-${Math.random().toString(36).substring(7)}`;
  const tagsStr = input.tags ? JSON.stringify(input.tags) : null;

  db.run(
    `INSERT INTO flashcards (id, notebook_id, note_id, front, back, tags, ease_factor, interval_days, repetitions, next_review, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 2.5, 0, 0, ?, ?, ?)`,
    [id, input.notebookId, input.noteId || null, input.front, input.back, tagsStr, now, now, now]
  );

  return getFlashcard(id)!;
}

export function getFlashcard(id: string): Flashcard | undefined {
  const db = getDatabase();
  const result = db.exec('SELECT * FROM flashcards WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return undefined;
  return rowToFlashcard(result[0].values[0]);
}

export function listFlashcards(notebookId: string): Flashcard[] {
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
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE note_id = ? ORDER BY next_review ASC, created_at DESC',
    [noteId]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
}

export function getDueFlashcards(notebookId: string): Flashcard[] {
  const db = getDatabase();
  const now = Date.now();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE notebook_id = ? AND next_review <= ? ORDER BY next_review ASC',
    [notebookId, now]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
}

// C5: 按笔记 ID 获取待复习闪卡
export function getDueFlashcardsByNote(noteId: string): Flashcard[] {
  const db = getDatabase();
  const now = Date.now();
  const result = db.exec(
    'SELECT * FROM flashcards WHERE note_id = ? AND next_review <= ? ORDER BY next_review ASC',
    [noteId, now]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToFlashcard);
}

export function updateFlashcard(id: string, update: Partial<Pick<Flashcard, 'front' | 'back' | 'tags'>>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.front !== undefined) { fields.push('front = ?'); values.push(update.front); }
  if (update.back !== undefined) { fields.push('back = ?'); values.push(update.back); }
  if (update.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(update.tags)); }

  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.run(`UPDATE flashcards SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function deleteFlashcard(id: string): void {
  const db = getDatabase();
  db.run('DELETE FROM flashcards WHERE id = ?', [id]);
}

export function deleteFlashcardsByNotebook(notebookId: string): void {
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

  const db = getDatabase();
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
