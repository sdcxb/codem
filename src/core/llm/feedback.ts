/**
 * Feedback — 反馈机制
 *
 * 设计对标 DSH `command-feedback` + `message-feedback`。
 *
 * 两层反馈：
 * 1. 会话级反馈：用户通过 /feedback 命令记录关于整个会话的反馈
 *    — 记录为事件日志中的 feedback/record 事件（log-only，不进入模型上下文）
 * 2. 消息级反馈：per-message rating + optional note
 *    — 存储在 message_feedback sidecar 表（已有基础）
 *    — 增加 note 字段支持
 *
 * 关键设计（与 DSH 一致）：
 * - feedback/record 是 log-only 事件 — 不出现在投影消息中
 * - 消息级反馈是 sidecar — 不影响事件日志
 * - 版本控制：乐观并发控制（ifVersion 匹配）
 * - note 有最大字节限制
 */

import { getDatabase, persistDatabase } from "../storage/database";
import { getEventLog } from "../storage/event-log";

// ========== Types ==========

export type FeedbackRating = "like" | "dislike" | "neutral";

export interface MessageFeedbackItem {
  messageId: string;
  rating: FeedbackRating;
  note?: string;
  version: string; // 乐观并发 token
  createdAt: number;
  updatedAt: number;
}

export interface SessionFeedbackEntry {
  /** 事件日志中的 seq */
  seq: number;
  /** 反馈文本 */
  text: string;
  /** 记录时间 */
  timestamp: number;
}

// ========== Configuration ==========

/** note 的最大 UTF-8 字节数 */
const MAX_NOTE_BYTES = 4096;

// ========== Session-Level Feedback ==========

/**
 * 记录会话级反馈 — 追加 feedback/record 事件到事件日志。
 *
 * 这是 log-only 事件：不进入模型上下文投影。
 * 对标 DSH `recordFeedback(session, text)`。
 *
 * @param sessionId 目标会话
 * @param text 反馈文本（trim 后不能为空）
 * @throws TypeError 当文本为空
 */
export function recordSessionFeedback(sessionId: string, text: string): void {
  const normalized = text.trim();
  if (normalized.length === 0) {
    throw new TypeError("feedback text must not be empty");
  }

  getEventLog().append(sessionId, "session_meta", {
    action: "feedback_record",
    text: normalized,
  });
}

/**
 * 读取会话的所有反馈记录。
 * 从事件日志中过滤 session_meta + action=feedback_record 事件。
 */
export function listSessionFeedback(sessionId: string): SessionFeedbackEntry[] {
  const events = getEventLog().readAll(sessionId);
  return events
    .filter(
      (e) =>
        e.type === "session_meta" &&
        (e.payload as any)?.action === "feedback_record",
    )
    .map((e) => ({
      seq: e.seq,
      text: (e.payload as any).text,
      timestamp: e.timestamp,
    }));
}

// ========== Message-Level Feedback (Sidecar) ==========

/**
 * 验证 note 的字节长度。
 */
function validateNote(note: string | undefined): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (note === undefined) return { ok: true, value: undefined };
  if (note.trim().length === 0) {
    return { ok: false, error: "note must not be blank" };
  }
  const bytes = Buffer.byteLength(note, "utf8");
  if (bytes > MAX_NOTE_BYTES) {
    return { ok: false, error: `note too large: ${bytes} bytes (max ${MAX_NOTE_BYTES})` };
  }
  return { ok: true, value: note };
}

/**
 * 确保 message_feedback 表有 note 和 version 列。
 */
function ensureNoteColumn(): void {
  const db = getDatabase();
  try {
    db.run("ALTER TABLE message_feedback ADD COLUMN note TEXT");
  } catch {
    // 列已存在
  }
  try {
    db.run("ALTER TABLE message_feedback ADD COLUMN version TEXT");
  } catch {
    // 列已存在
  }
  try {
    db.run("ALTER TABLE message_feedback ADD COLUMN created_at INTEGER");
  } catch {
    // 列已存在
  }
  try {
    db.run("ALTER TABLE message_feedback ADD COLUMN updated_at INTEGER");
  } catch {
    // 列已存在
  }
}

/**
 * 创建或替换消息级反馈。
 *
 * 乐观并发：如果该消息已有反馈，request 中的 ifVersion 必须匹配。
 * 对标 DSH MessageFeedbackService.put()。
 *
 * @returns 成功则返回提交的 item，失败返回错误信息
 */
export function putMessageFeedback(
  sessionId: string,
  messageId: string,
  rating: FeedbackRating,
  note?: string,
  ifVersion?: string | null,
): { ok: true; item: MessageFeedbackItem } | { ok: false; error: string } {
  ensureNoteColumn();

  const noteResult = validateNote(note);
  if (!noteResult.ok) return { ok: false, error: noteResult.error };

  const db = getDatabase();
  const now = Date.now();

  // 查找现有反馈
  const existing = getMessageFeedback(messageId);

  // 版本检查
  const currentVersion = existing?.version ?? null;
  if (ifVersion !== currentVersion) {
    return {
      ok: false,
      error: `version-conflict: expected ${ifVersion ?? "null"}, got ${currentVersion ?? "null"}`,
    };
  }

  // 如果完全相同，返回现有（no-op）
  if (
    existing &&
    existing.rating === rating &&
    existing.note === noteResult.value
  ) {
    return { ok: true, item: existing };
  }

  const newVersion = crypto.randomUUID();

  // 删除现有
  db.run("DELETE FROM message_feedback WHERE message_id = ?", [messageId]);

  // 插入新记录
  db.run(
    `INSERT INTO message_feedback (id, message_id, session_id, feedback, timestamp, note, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `fb-${messageId}`,
      messageId,
      sessionId,
      rating,
      now,
      noteResult.value ?? null,
      newVersion,
      existing?.createdAt ?? now,
      now,
    ],
  );
  persistDatabase();

  return {
    ok: true,
    item: {
      messageId,
      rating,
      ...(noteResult.value !== undefined ? { note: noteResult.value } : {}),
      version: newVersion,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  };
}

/**
 * 获取消息级反馈。
 */
export function getMessageFeedback(messageId: string): MessageFeedbackItem | null {
  ensureNoteColumn();
  const db = getDatabase();
  const result = db.exec(
    `SELECT message_id, feedback, note, version, created_at, updated_at
     FROM message_feedback WHERE message_id = ?`,
    [messageId],
  );

  if (result.length === 0 || result[0].values.length === 0) return null;

  const row = result[0].values[0];
  return {
    messageId: row[0] as string,
    rating: row[1] as FeedbackRating,
    ...(row[2] ? { note: row[2] as string } : {}),
    version: (row[3] as string) || "",
    createdAt: (row[4] as number) || 0,
    updatedAt: (row[5] as number) || 0,
  };
}

/**
 * 删除消息级反馈。
 * 对标 DSH MessageFeedbackService.delete()。
 */
export function deleteMessageFeedback(
  messageId: string,
  ifVersion?: string | null,
): { ok: true; absent: boolean } | { ok: false; error: string } {
  ensureNoteColumn();
  const db = getDatabase();

  const existing = getMessageFeedback(messageId);
  if (!existing) {
    return { ok: true, absent: true };
  }

  if (ifVersion !== existing.version) {
    return {
      ok: false,
      error: `version-conflict: expected ${ifVersion ?? "null"}, got ${existing.version}`,
    };
  }

  db.run("DELETE FROM message_feedback WHERE message_id = ?", [messageId]);
  persistDatabase();
  return { ok: true, absent: true };
}

/**
 * 列出会话的所有消息级反馈。
 */
export function listMessageFeedback(sessionId: string): MessageFeedbackItem[] {
  ensureNoteColumn();
  const db = getDatabase();
  const result = db.exec(
    `SELECT message_id, feedback, note, version, created_at, updated_at
     FROM message_feedback WHERE session_id = ? ORDER BY created_at ASC`,
    [sessionId],
  );

  if (result.length === 0) return [];

  return result[0].values.map((row) => ({
    messageId: row[0] as string,
    rating: row[1] as FeedbackRating,
    ...(row[2] ? { note: row[2] as string } : {}),
    version: (row[3] as string) || "",
    createdAt: (row[4] as number) || 0,
    updatedAt: (row[5] as number) || 0,
  }));
}
