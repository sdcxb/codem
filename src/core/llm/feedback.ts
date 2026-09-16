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
import { getStoragePort, hasStoragePort } from "../storage/port";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "../storage/domain-store";

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
 *
 * ## P5 第 1 段：这四列已经进了真源，这里只剩"兼容老库"的兜底
 *
 * 原来这四列**只**靠这个函数在运行期 `ALTER TABLE` 加 —— 而 `gen-schema-sql.mjs`
 * 只读 SCHEMA，看不见这些 ALTER，于是 Rust 侧的库根本没有这四列，
 * `putMessageFeedback()` 按九列写入被 Rust 引擎直接拒收（真机实测确认）。
 * 现在四列已在 SCHEMA 里声明、并由 migrations 补齐（两条路径都幂等），
 * 这个函数因此**不再是必需的**，保留只是为了兼容"列确实缺失"的极端老库。
 *
 * 安全边界（必须记住）：Rust 侧引擎**不允许 ALTER**（authorizer 只放行只读语句），
 * 所以这里在端口可用时**直接跳过** —— 否则每次调用都会产生一条注定失败、且毫无意义的
 * 引擎往返。端口可用就意味着 schema+迁移已经应用过，列必然存在。
 *
 * 判据用 `hasStoragePort()`（任何引擎）而不是"端口是 rust"：
 * 端口存在就说明磁盘 schema 由引擎自己管，渲染侧不该再碰 `getDatabase()` ——
 * 否则在"端口已注册但镜像尚未加载"的窗口里，这个函数会把旧库拉起来
 * （踩过一次：契约测试里表现为"旧库不应在已路由的域上被访问"）。
 */
function ensureNoteColumn(): void {
  if (hasStoragePort()) return;
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

// ========== 行 ↔ 线协议行（P5 第 1 段：走域端口，不再依赖 WASM 库） ==========

const TABLE = "message_feedback";

interface FeedbackWireRow {
  id: string;
  message_id: string;
  session_id: string;
  feedback: FeedbackRating;
  timestamp: number;
  note: string | null;
  version: string | null;
  created_at: number | null;
  updated_at: number | null;
}

function wireToFeedback(row: Record<string, unknown>): FeedbackWireRow {
  return {
    id: String(row.id ?? ""),
    message_id: String(row.message_id ?? ""),
    session_id: String(row.session_id ?? ""),
    feedback: String(row.feedback ?? "like") as FeedbackRating,
    timestamp: Number(row.timestamp ?? 0),
    note: (row.note as string) ?? null,
    version: (row.version as string) ?? null,
    created_at: (row.created_at as number) ?? null,
    updated_at: (row.updated_at as number) ?? null,
  };
}

function feedbackToItem(row: FeedbackWireRow): MessageFeedbackItem {
  return {
    messageId: row.message_id,
    rating: row.feedback,
    ...(row.note ? { note: row.note } : {}),
    version: row.version || "",
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
  };
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

  const item: MessageFeedbackItem = {
    messageId,
    rating,
    ...(noteResult.value !== undefined ? { note: noteResult.value } : {}),
    version: newVersion,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // 迁移期：先用镜像判空/取现有行，再整体写回（旧实现是 DELETE + INSERT 两条语句，
  // 中间失败会留下"反馈消失"的状态；整体 upsert 没有这个中间态）。
  const rustExisting = domainReadOne(TABLE, { message_id: messageId }, wireToFeedback);
  if (rustExisting !== undefined) {
    const writeRow = (): void => {
      domainWrite(
        TABLE,
        [{
          id: `fb-${messageId}`,
          message_id: messageId,
          session_id: sessionId,
          feedback: rating,
          timestamp: now,
          note: noteResult.value ?? null,
          version: newVersion,
          created_at: item.createdAt,
          updated_at: now,
        }],
        { mode: "replace", scope: "feedback.put", note: "消息反馈未保存" },
      );
    };
    if (rustExisting && rustExisting.id !== `fb-${messageId}`) {
      // 历史行用了别的 id（例如 message.ts 的轻量路径写的 `fb-...`）：
      // 先删掉再加，保持"一条消息最多一条反馈"这个不变量。
      domainDelete(TABLE, { id: rustExisting.id }, { scope: "feedback.replace", note: "旧反馈未删除" });
    }
    writeRow();
    return { ok: true, item };
  }

  const legacyDb = getDatabase();

  // 删除现有
  legacyDb.run("DELETE FROM message_feedback WHERE message_id = ?", [messageId]);

  // 插入新记录
  legacyDb.run(
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

  return { ok: true, item };
}

/**
 * 获取消息级反馈。
 */
export function getMessageFeedback(messageId: string): MessageFeedbackItem | null {
  ensureNoteColumn();
  const rust = domainReadOne(TABLE, { message_id: messageId }, wireToFeedback);
  if (rust !== undefined) return rust ? feedbackToItem(rust) : null;
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

  const rust = domainReadOne(TABLE, { message_id: messageId }, wireToFeedback);
  if (rust !== undefined) {
    if (rust) {
      domainDelete(TABLE, { id: rust.id }, { scope: "feedback.delete", note: "消息反馈未删除" });
    }
    return { ok: true, absent: true };
  }

  const legacyDb = getDatabase();
  legacyDb.run("DELETE FROM message_feedback WHERE message_id = ?", [messageId]);
  persistDatabase();
  return { ok: true, absent: true };
}
/**
 * 列出会话的所有消息级反馈。
 */
export function listMessageFeedback(sessionId: string): MessageFeedbackItem[] {
  ensureNoteColumn();
  const rust = domainReadMany(TABLE, wireToFeedback, { session_id: sessionId });
  if (rust) {
    // 旧 SQL：ORDER BY created_at ASC（NULL 排在最前，与 SQLite 一致）
    return rust
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
      .map(feedbackToItem);
  }
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
