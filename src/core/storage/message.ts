import { appendSessionMessage, appendMessageTombstone, readSessionMessages } from "./session-jsonl";
import { runGuarded } from "./write-guard";
import {
  getCachedExternalContent,
  warmExternalContent,
  hydrateAttachmentsForSession,
  externalizeAttachmentContent,
  isExternalContent,
  DEFAULT_EXTERNALIZE_THRESHOLD,
} from "./attachment-files";
import { getDatabase, persistDatabase, isFts5Available, isDatabaseFatal, noteDatabaseError } from "./database";
import { getEventLog } from "./event-log";
import { getStoragePort, hasStoragePort } from "./port";
import type { SessionEventType } from "./event-types";
import type { Message, ToolCall, MessageAttachment, RetrievedSource } from "../../store";
import { safeJsonParse } from "../utils/safe-json";
import { reportPersistFailure } from "./persist-failure";

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  timestamp: number;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  status: string;
  generated_files: string | null;
  retrieved_sources: string | null;
}

export interface ToolCallRow {
  id: string;
  message_id: string;
  tool: string;
  args: string;
  result: string | null;
  status: string;
}

function rowToMessage(row: MessageRow, toolCalls: ToolCall[], attachments?: MessageAttachment[]): Message {
  return {
    id: row.id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    status: row.status as Message["status"],
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    generatedFiles: row.generated_files ? safeJsonParse(row.generated_files, undefined) : undefined,
    retrievedSources: row.retrieved_sources ? safeJsonParse(row.retrieved_sources, undefined) : undefined,
  };
}

function rowToToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    tool: row.tool,
    args: JSON.parse(row.args),
    result: row.result ?? undefined,
    status: row.status as ToolCall["status"],
  };
}

function rowToToolCallFromAny(tr: any[]): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tr[3] as string);
  } catch {
    args = {};
  }
  let metadata: Record<string, any> | undefined;
  try {
    if (tr[6]) metadata = JSON.parse(tr[6] as string);
  } catch { /* non-fatal */ }
  return {
    id: tr[0] as string,
    tool: tr[2] as string,
    args,
    result: (tr[4] as string | null) ?? undefined,
    status: (tr[5] as string) as ToolCall["status"],
    ...(metadata ? { metadata } : {}),
  };
}

function loadToolCallsForMessage(db: any, messageId: string): ToolCall[] {
  const toolResult = db.exec(
    "SELECT * FROM tool_calls WHERE message_id = ? ORDER BY rowid ASC",
    [messageId]
  );
  return toolResult.length > 0 ? toolResult[0].values.map(rowToToolCallFromAny) : [];
}

/** Load attachments associated with a specific message (by message_id) */
function loadAttachmentsForMessage(db: any, messageId: string): MessageAttachment[] {
  try {
    const result = db.exec(
      "SELECT id, name, type, path, content, preview, sandbox_path, mime_type, size FROM attachments WHERE message_id = ? ORDER BY added_at ASC",
      [messageId]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      name: row[1] as string,
      type: row[2] as "file" | "image" | "code" | "url",
      path: row[3] as string | undefined,
      content: row[4] as string | undefined,
      preview: row[5] as string | undefined,
      sandboxPath: row[6] as string | undefined,
      mimeType: row[7] as string | undefined,
      size: row[8] as number | undefined,
    }));
  } catch (e) {
    console.warn("[loadAttachmentsForMessage] Failed:", e);
    return [];
  }
}

/**
 * 有界裁剪 SQLite 索引 —— **只有确实已在 JSONL 里持久化的消息才允许删**（第 78 波）。
 *
 * 这是"SQLite 只是可重建索引"的落地：权威日志是 append-only JSONL，索引可以随体积增长被裁剪，
 * 但裁剪必须满足**耐久性不变量**：一条消息只要还没进 JSONL，就绝不能被删。
 * 读取侧（`loadMessagesWithDurableLog`）会把 JSONL 与索引合并，被裁掉的历史仍然读得到。
 *
 * 附加约束（数据完整性）：
 *   - 带附件（attachments）的消息**不裁**：附件行不在 JSONL 里，裁消息会级联删掉附件；
 *   - 每个会话至少保留最新 `keepPerSession` 条（默认 500），常用会话完全不触发裁剪。
 *
 * @returns 裁剪的消息数与跳过的会话数（因耐久性不足而放弃）
 */
export async function trimIndexedMessages(
  opts: { keepPerSession?: number } = {},
): Promise<{ deletedMessages: number; skippedSessions: number }> {
  const keepPerSession = opts.keepPerSession ?? 500;
  const out = { deletedMessages: 0, skippedSessions: 0 };
  const db = getDatabase();

  let sessionIds: string[] = [];
  try {
    const rows = db.exec("SELECT DISTINCT session_id FROM messages");
    sessionIds = rows?.[0]?.values?.map((r) => String(r[0])) ?? [];
  } catch {
    return out;
  }

  const { durableMessageIds, flushSessionLogWrites } = await import("./session-jsonl");
  // 先把在途的追加写等齐：耐久性检查必须看到最新日志，否则会"该裁的没裁"或误判
  await flushSessionLogWrites();

  for (const sessionId of sessionIds) {
    try {
      const countRows = db.exec("SELECT count(*) FROM messages WHERE session_id = ?", [sessionId]);
      const total = Number(countRows?.[0]?.values?.[0]?.[0] ?? 0);
      if (total <= keepPerSession) continue;

      const durable = await durableMessageIds(sessionId);
      if (durable.size === 0) {
        out.skippedSessions++; // 老会话尚未回填 → 一律不动
        continue;
      }

      const candidates = db.exec(
        "SELECT id FROM messages WHERE session_id = ? AND hidden = 0 ORDER BY timestamp DESC LIMIT -1 OFFSET ?",
        [sessionId, keepPerSession],
      );
      const candidateIds = candidates?.[0]?.values?.map((r) => String(r[0])) ?? [];
      if (candidateIds.length === 0) continue;

      const withAttachments = new Set(
        db.exec(
          "SELECT DISTINCT message_id FROM attachments WHERE session_id = ? AND message_id IS NOT NULL",
          [sessionId],
        )?.[0]?.values?.map((r) => String(r[0])) ?? [],
      );
      const deletable = candidateIds.filter((id) => durable.has(id) && !withAttachments.has(id));
      if (deletable.length === 0) {
        out.skippedSessions++;
        continue;
      }
      for (const id of deletable) {
        db.run("DELETE FROM messages WHERE id = ?", [id]); // tool_calls 由外键级联删除
      }
      out.deletedMessages += deletable.length;
      console.log(`[Index] 会话 ${sessionId} 裁剪索引 ${deletable.length} 条（均在 JSONL 中；附件消息已跳过）`);
    } catch (e) {
      console.warn(`[Index] 会话 ${sessionId} 裁剪失败（跳过）:`, e);
      out.skippedSessions++;
    }
  }
  if (out.deletedMessages > 0) persistDatabase();
  return out;
}

/**
 * 读取会话历史：**权威日志（JSONL）+ SQLite 索引合并**（第 78 波）。
 *
 * 为什么需要合并：索引可以被有界裁剪（`trimIndexedMessages`），被裁掉的历史只存在于 JSONL 里。
 * 合并规则：以 JSONL 为准（它就是权威），索引里多的（例如附件、尚未进日志的最近消息）也保留；
 * 同 id 用 JSONL 的版本。排序按 timestamp。
 *
 * 这是同步接口 —— UI 的加载路径目前是同步的，所以这里只读**已缓存的日志**；
 * 首次加载时若日志还没读进内存，则先用索引（随后 `hydrateSessionLog` 会补齐）。
 */
export function listMessagesMerged(sessionId: string, limit?: number): Message[] {
  const fromIndex = listMessagesFromIndex(sessionId, limit);
  const cached = cachedLogMessages.get(sessionId);
  if (!cached || cached.length === 0) return fromIndex;

  /**
   * 第 83 波：**索引里的 hidden 状态也是权威**（软删除行只在索引里）。
   *
   * `listMessagesFromIndex` 用 `WHERE hidden = 0` 过滤掉了它们，而日志里没有对应的墓碑
   * （老版本压缩只改索引），于是合并会把它们**当成"索引里没有、日志里有"的历史**重新加回来 ——
   * 这正是用户现场"压缩了 840 条、上下文一点没小"的机制。对已经踩过坑的会话（索引里已有
   * hidden=1 的行）也要能恢复：这里显式取一次 hidden id 集合，合并时一律排除。
   *
   * 这些行是**软删除**、且 `trimIndexedMessages` 只裁 `hidden = 0` 的行，所以这个集合长期有效。
   */
  const hiddenIds = hiddenMessageIds(sessionId);
  const merged = new Map<string, Message>();
  for (const m of fromIndex) merged.set(m.id, m);
  for (const rec of cached) {
    /**
     * 第 83 波（防御纵深）：日志镜像里被标记为删除/隐藏的记录**绝不能**进读集合。
     *
     * 为什么必须有这一层：`readSessionMessages` 已经过滤墓碑，但**镜像可能是删除之前填充的**
     * （`hydrateSessionLog` 进会话时读一次）。只要哪条删除路径漏了同步镜像，
     * 磁盘逻辑再正确，本进程内也照样"复活"—— 压缩被复活 = 上下文永不缩小 = 死循环，
     * 代价太大。所以这里按最保守处理：宁可少显示，绝不复活。
     */
    if ((rec as any).deleted === true || (rec as any).hidden === true || hiddenIds.has(rec.id)) {
      merged.delete(rec.id);
      continue;
    }
    const existing = merged.get(rec.id);
    merged.set(rec.id, {
      ...(existing ?? ({} as Message)),
      id: rec.id,
      role: rec.role as Message["role"],
      content: rec.content,
      timestamp: rec.timestamp,
      ...(rec.reasoning ? { reasoning: rec.reasoning } : {}),
      ...(rec.model ? { model: rec.model } : {}),
      ...((rec as any).toolCalls ? { toolCalls: (rec as any).toolCalls } : {}),
    } as Message);
  }
  const all = [...merged.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return limit ? all.slice(-limit) : all;
}

/** 索引里被软删除（hidden=1）的消息 id 集合 */
function hiddenMessageIds(sessionId: string): Set<string> {
  // 迁移期分流：走 Rust 时**必须**用镜像的 hidden 集合 ——
  // 索引里的 hidden 状态是权威（软删除行只在索引里），用旧库那份会把已压缩的消息**复活**
  // （见 listMessagesMerged 的注释：那正是"压缩了 840 条、上下文一点没小"的机制）。
  const routed = rustMessageSource(sessionId);
  if (routed?.messages) return routed.messages.hiddenIds(sessionId);
  try {
    const rows = getDatabase().exec("SELECT id FROM messages WHERE session_id = ? AND hidden = 1", [sessionId]);
    return new Set((rows?.[0]?.values ?? []).map((r: any[]) => String(r[0])));
  } catch {
    return new Set();
  }
}

/** 会话日志的内存镜像（由 hydrateSessionLog 填充） */
const cachedLogMessages = new Map<string, Awaited<ReturnType<typeof readSessionMessages>>["messages"]>();

/** 第 91 波：索引不可用只提示一次（数据库致命时否则每次读都刷一行） */
let warnedIndexUnavailable = false;
function warnIndexUnavailable(e: unknown): void {
  const fatal = isDatabaseFatal();
  if (fatal && warnedIndexUnavailable) return;
  warnedIndexUnavailable = true;
  console.warn(
    `[MessageStorage] 索引暂不可用（${e instanceof Error ? e.message : String(e)}）—— ` +
      (fatal
        ? "数据库模块已崩溃，本次运行内改为**只读权威日志**（会话历史仍完整可读）。"
        : "本次读取回退到权威日志。"),
  );
}

/** 从日志镜像里按 id 取一条消息（索引不可用时的兜底） */
export function logMirrorMessage(sessionId: string, id: string): Message | null {
  const mirror = cachedLogMessages.get(sessionId);
  if (!mirror) return null;
  const rec: any = mirror.find((m) => m.id === id);
  if (!rec) return null;
  return {
    id: rec.id,
    role: rec.role,
    content: rec.content ?? "",
    timestamp: rec.timestamp ?? Date.now(),
    ...(rec.reasoning ? { reasoning: rec.reasoning } : {}),
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.status ? { status: rec.status } : {}),
    ...(rec.toolCalls ? { toolCalls: rec.toolCalls } : {}),
  } as Message;
}

/** 在整个日志镜像里找一个消息 id 属于哪个会话（索引不可用时的兜底） */
function sessionIdFromLogMirror(messageId: string): string | null {
  for (const [sessionId, mirror] of cachedLogMessages) {
    if (mirror.some((m) => m.id === messageId)) return sessionId;
  }
  return null;
}

/**
 * 把会话的追加日志读进内存镜像（进入会话时调用一次）。
 * 之后 listMessagesMerged 就能同步合并出被索引裁掉的历史。
 */
export async function hydrateSessionLog(sessionId: string): Promise<number> {
  try {
    const { messages } = await readSessionMessages(sessionId);
    cachedLogMessages.set(sessionId, messages);
    return messages.length;
  } catch (e) {
    console.warn("[SessionJSONL] 读取日志失败（回退到索引）:", e);
    return 0;
  }
}

/** 测试/会话关闭时清理镜像 */
export function clearSessionLogCache(sessionId?: string): void {
  if (sessionId) cachedLogMessages.delete(sessionId);
  else cachedLogMessages.clear();
}

/**
 * 读取会话历史 —— **索引 + 追加日志合并**（第 79 波审计修正）。
 *
 * 审计发现（严重）：上一波实现了"索引可被有界裁剪"+"日志是权威"，但**读路径没接上**：
 * `listMessages` 仍然只读索引，而全平台有几十处调用它（UI 的 `store.loadMessages`、
 * agentic loop 的上下文、fork、导出、上下文监控、不变量检查…）。于是被裁掉的历史会**凭空消失**
 * （真机上已经裁掉 112 条）。这里把合并收进 `listMessages` 本身：只要日志镜像已 hydrate
 * （启动维护会回填并 hydrate），**所有调用点自动拿到完整历史**。
 */
export function listMessages(sessionId: string, limit?: number): Message[] {
  return listMessagesMerged(sessionId, limit);
}

/** 只读 SQLite 索引（内部/诊断用）；对外请用 `listMessages`（会合并权威日志） */
export function listMessagesFromIndex(sessionId: string, limit?: number): Message[] {
  /**
   * 迁移期分流（P3 第 7 段）：端口是 rust 且该会话索引**已加载** → 从镜像读。
   *
   * 这里是读路径的入口（在 `listMessagesMerged` 里比 `hiddenMessageIds` 先执行），
   * 所以把"触发加载"放在这里，能保证同一个会话的 hidden 状态与列表来自**同一份数据**。
   */
  const routed = rustMessageSource(sessionId);
  if (routed) {
    const all = routed.messages!.list(sessionId);
    // 与旧实现的语义对齐：索引列表**只含可见行**（`WHERE hidden = 0`）。
    // 镜像为了 hidden 判定必须加载全部行，所以这里是读的时候过滤
    // （契约测试 MSG-8 抓到过漏过滤 —— 那会让已压缩的消息重新出现在对话里）。
    const visible = all.filter((m) => !m.hidden);
    // limit 语义与旧实现一致：取**最后** limit 条（`listMessagesMerged` 也是 slice(-limit)）
    const rows = limit ? visible.slice(-limit) : visible;
    return rows.map(messageRowToMessage);
  }
  /**
   * 第 91 波（架构级修正）：索引是**可重建的查询索引**，日志才是权威 ——
   * 所以索引不可用时（数据库致命状态 / SQL 报错）**不能让读路径整体失败**：
   * 返回空列表，交给 `listMessagesMerged` 用权威日志拼出完整历史。
   * 原来这里 `getDatabase()` 直接抛错 → 数据库一崩，连"读会话历史"都失败，
   * 明明日志里一切都还在。
   */
  let db: any;
  try {
    db = getDatabase();
  } catch (e) {
    warnIndexUnavailable(e);
    return [];
  }
  let result: any;
  try {
    const limitClause = limit ? `LIMIT ${limit}` : "";
    result = db.exec(
      `SELECT id, session_id, role, content, timestamp, model, prompt_tokens, completion_tokens, cost, status, reasoning, generated_files, retrieved_sources, hidden FROM messages WHERE session_id = ? AND hidden = 0 ORDER BY timestamp ASC ${limitClause}`,
      [sessionId]
    );
  } catch (e) {
    warnIndexUnavailable(e);
    return [];
  }
  if (result.length === 0) return [];

  return result[0].values.map((row: any[]) => {
    try {
      const messageRow: MessageRow = {
        id: row[0] as string,
        session_id: row[1] as string,
        role: row[2] as string,
        content: row[3] as string,
        timestamp: row[4] as number,
        model: row[5] as string | null,
        prompt_tokens: row[6] as number,
        completion_tokens: row[7] as number,
        cost: row[8] as number,
        status: row[9] as string,
        reasoning: row[10] as string | null,
        generated_files: row[11] as string | null,
        retrieved_sources: row[12] as string | null,
      };
      const toolCalls = loadToolCallsForMessage(db, messageRow.id);
      const attachments = loadAttachmentsForMessage(db, messageRow.id);
      const msg = rowToMessage(messageRow, toolCalls, attachments);
      // Attach hidden flag for UI to show "compacted" marker
      (msg as any).hidden = row[13] === 1;
      return msg;
    } catch (e) {
      console.warn("[listMessages] Failed to convert row:", e);
      return null;
    }
  }).filter((m): m is Message => m !== null);
}

/** List only non-hidden messages (for LLM context building) */
export function listVisibleMessages(sessionId: string): Message[] {
  const all = listMessages(sessionId);
  return all.filter(m => !(m as any).hidden);
}

/**
 * List all attachments across all sessions (for cross-session reuse).
 * Returns attachments with their owning session_id and message_id.
 *
 * P0-FIX: Excludes the `content` column from the listing query. Previously
 * this SELECT loaded every attachment's FULL TEXT CONTENT into memory —
 * for a 2000-page document that's tens of MB per row. Now only metadata is
 * loaded; content is fetched on demand via {@link getAttachmentContent}.
 * Also adds a default LIMIT of 200 to prevent unbounded result sets.
 */
export function listAllAttachments(limit?: number): Array<MessageAttachment & { sessionId: string; messageId: string }> {
  const db = getDatabase();
  const effectiveLimit = limit ?? 200;
  const limitClause = `LIMIT ${effectiveLimit}`;
  try {
    const result = db.exec(
      `SELECT id, session_id, message_id, name, type, path, preview, sandbox_path, mime_type, size FROM attachments ORDER BY added_at DESC ${limitClause}`
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      messageId: row[2] as string,
      name: row[3] as string,
      type: row[4] as "file" | "image" | "code" | "url",
      path: row[5] as string | undefined,
      content: undefined, // Lazy-loaded via getAttachmentContent
      preview: row[6] as string | undefined,
      sandboxPath: row[7] as string | undefined,
      mimeType: row[8] as string | undefined,
      size: row[9] as number | undefined,
    }));
  } catch (e) {
    console.warn("[listAllAttachments] Failed:", e);
    return [];
  }
}

/**
 * P0-FIX: Lazy-load a single attachment's content by ID. This prevents the
 * listing query from pulling every attachment's full text into memory —
 * only the specific attachment the LLM requested is loaded.
 */
/**
 * 大附件内容外置（第 80 波）。
 * 返回要写进 `content` 列的值（标记或原文）与 `preview` 列的值。
 * 失败时回退内联 —— 宁可库大一点，也不能把附件内容丢掉。
 */
function externalizeIfLargeSync(att: MessageAttachment): { content: string | null; preview: string | null } {
  const content = typeof att.content === "string" ? att.content : null;
  const preview = att.preview ?? null;
  if (!content) return { content, preview };

  if (isExternalContent(content)) return { content, preview }; // 已经外置过
  if (content.length <= DEFAULT_EXTERNALIZE_THRESHOLD) return { content, preview };
  // 同步路径**先写内联**（保证不丢数据），同时排队外置；外置成功后把标记写回数据库。
  // 这样 `createMessage` 不必变成 async —— 几十处调用点都依赖它是同步的。
  queueAttachmentExternalization(att.id, att.name, content);
  return { content, preview };
}

/** 排队把附件内容外置（异步、幂等、失败保留内联） */
const pendingExternalization = new Set<string>();
function queueAttachmentExternalization(attachmentId: string, name: string, content: string): void {
  if (pendingExternalization.has(attachmentId)) return;
  pendingExternalization.add(attachmentId);
  void (async () => {
    try {
      const { marker, preview } = await externalizeAttachmentContent(attachmentId, name, content);
      const db = getDatabase();
      runGuarded(
        db,
        "UPDATE attachments SET content = ?, preview = COALESCE(preview, ?) WHERE id = ?",
        [marker, preview, attachmentId],
        { table: "attachments", op: "externalize", id: attachmentId, from: "externalizeAttachment" },
      );
      persistDatabase();
      await hydrateAttachmentsForSession([{ id: attachmentId, content: marker }]);
    } catch (e) {
      console.warn("[Attachment] 外置失败，保留内联（不影响使用）:", e);
    } finally {
      pendingExternalization.delete(attachmentId);
    }
  })();
}

/**
 * 重建全文检索索引，使其与"读者能看到的消息"严格一致（第 80 波收尾项）。
 *
 * 背景：`session_fts` 是独立表、没有外键级联 —— 索引被裁剪（或消息被删除）之后，
 * FTS 里会留下**孤儿行**（真机实测 112 条）。上一波靠 `getMessage` 回退保证了"命中还能打开"，
 * 但那只是兜住了读取；这一版把一致性做正：
 *   - 删掉"既不在索引、也不在日志镜像"的行（消息已被墓碑删除）；
 *   - 为"在日志镜像里但不在 FTS 里"的消息补行（被裁掉但仍可读的历史，搜索也应该能搜到）。
 *
 * @returns 删除与补充的行数
 */
export async function rebuildSessionFts(sessionId: string): Promise<{ removed: number; added: number }> {
  const out = { removed: 0, added: 0 };
  if (!isFts5Available()) return out;
  const db = getDatabase();
  try {
    const indexIds = new Set(
      db.exec("SELECT id FROM messages WHERE session_id = ?", [sessionId])?.[0]?.values?.map((r) => String(r[0])) ?? [],
    );
    const logRecords = cachedLogMessages.get(sessionId) ?? [];
    const readableIds = new Set<string>([...indexIds, ...logRecords.map((m) => m.id)]);

    const ftsIds =
      db.exec("SELECT message_id FROM session_fts WHERE session_id = ?", [sessionId])?.[0]?.values?.map((r) =>
        String(r[0]),
      ) ?? [];

    for (const id of ftsIds) {
      if (readableIds.has(id)) continue;
      db.run("DELETE FROM session_fts WHERE session_id = ? AND message_id = ?", [sessionId, id]);
      out.removed++;
    }

    const alreadyIndexed = new Set(ftsIds);
    for (const rec of logRecords) {
      if (alreadyIndexed.has(rec.id)) continue;
      try {
        db.run("INSERT INTO session_fts (session_id, message_id, content, role, timestamp) VALUES (?, ?, ?, ?, ?)", [
          sessionId,
          rec.id,
          rec.content,
          rec.role,
          rec.timestamp,
        ]);
        out.added++;
      } catch {
        /* 单条失败跳过 */
      }
    }
    if (out.removed > 0 || out.added > 0) {
      persistDatabase();
      console.log(`[FTS] 会话 ${sessionId} 索引对齐：删除孤儿 ${out.removed} 条、补齐 ${out.added} 条`);
    }
  } catch (e) {
    console.warn(`[FTS] 会话 ${sessionId} 索引对齐失败（跳过）:`, e);
  }
  return out;
}

export function getAttachmentContent(id: string): string | undefined {
  const db = getDatabase();
  try {
    const result = db.exec(
      `SELECT content FROM attachments WHERE id = ?`,
      [id]
    );
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const content = result[0].values[0][0];
    if (!content) return undefined;
    const text = content as string;
    // 第 80 波：大附件内容外置在文件里。读取路径是同步的，所以走"预取 + 同步命中"：
    // 命中即返回全文；未命中时**补一次异步预取**（下次读取命中），
    // 绝不让调用方拿到 `file:` 标记去当正文用。
    if (text.startsWith("file:")) {
      const path = text.slice("file:".length);
      const cached = getCachedExternalContent(path);
      if (cached !== undefined) return cached;
      void warmExternalContent(path);
      console.warn("[getAttachmentContent] 外置附件尚未预热，已触发预取（请重试一次）:", path);
      return undefined;
    }
    return text;
  } catch (e) {
    console.warn("[getAttachmentContent] Failed:", e);
    return undefined;
  }
}

export function getMessage(id: string): Message | null {
  const db = getDatabase();
  const result = db.exec("SELECT id, session_id, role, content, timestamp, model, prompt_tokens, completion_tokens, cost, status, reasoning, generated_files, retrieved_sources FROM messages WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) {
    // 第 79 波审计修正：索引被有界裁剪后，这个 id 可能只存在于权威日志里
    // （全文搜索命中、跨会话引用、fork 的按 id 读取都会走到这里）。
    // 回退到已 hydrate 的日志镜像，避免"搜索得到、点开却没有"的破图。
    for (const records of cachedLogMessages.values()) {
      const hit = records.find((m) => m.id === id);
      if (hit) {
        return {
          id: hit.id,
          role: hit.role as Message["role"],
          content: hit.content,
          timestamp: hit.timestamp,
          ...(hit.reasoning ? { reasoning: hit.reasoning } : {}),
          ...(hit.model ? { model: hit.model } : {}),
          ...((hit as any).toolCalls ? { toolCalls: (hit as any).toolCalls } : {}),
        } as Message;
      }
    }
    return null;
  }

  const row = result[0].values[0];
  const messageRow: MessageRow = {
    id: row[0] as string,
    session_id: row[1] as string,
    role: row[2] as string,
    content: row[3] as string,
    timestamp: row[4] as number,
    model: row[5] as string | null,
    prompt_tokens: row[6] as number,
    completion_tokens: row[7] as number,
    cost: row[8] as number,
    status: row[9] as string,
    reasoning: row[10] as string | null,
    generated_files: row[11] as string | null,
    retrieved_sources: row[12] as string | null,
  };

  const toolCalls = loadToolCallsForMessage(db, id);
  const attachments = loadAttachmentsForMessage(db, id);
  return rowToMessage(messageRow, toolCalls, attachments);
}

/**
 * 写入一条消息。
 *
 * 第 91 波（**架构级**修正）：**权威日志先写，索引尽力而为。**
 *
 * 本仓库的分层是"追加日志（JSONL）= 权威存储，SQLite = 可重建的查询索引"（第 78 波定的），
 * 但写入顺序一直是反的：先 `getDatabase()` + INSERT/UPDATE + `persistDatabase()`，
 * **最后**才 `appendSessionMessage(...)`。于是索引一出问题（WASM 陷阱、致命闩锁、SQL 报错），
 * 函数在第一行就抛掉，**权威日志那一步根本没执行** —— 用户那 113 条消息之所以危险，
 * 根子就在这：号称权威的那份副本，成了最脆弱那条路径的最后一道。
 *
 * 现在的顺序是：①日志先落盘（不受索引影响）→ ②再写索引；索引失败只上报、不再让调用方失败。
 */
export function createMessage(message: Message, sessionId: string): void {
  // ① 权威日志：追加即持久，不碰索引、不做整库导出
  void appendSessionMessage(sessionId, message);

  // ② 索引：尽力而为。索引崩了不影响上面那条已经落盘的记录。
  if (isDatabaseFatal()) return;
  try {
    writeMessageIndex(message, sessionId);
  } catch (e) {
    if (!noteDatabaseError(e)) {
      reportPersistFailure("message.createMessage.index", e, "消息已写入权威日志，但查询索引更新失败（索引可由日志重建）");
    }
  }
}

// ========== 迁移期：索引写分流到 Rust（P3 第 6 段） ==========
//
// ## 为什么索引写要整体交给 Rust
//
// 渲染侧的索引写不是"一次简单 upsert"：它要同时处理 messages 主行 +
// `generated_files` / `retrieved_sources` 两个 JSON 列 + **整批替换 tool_calls**
// （先 DELETE 再逐条 INSERT）。拆成多条 IPC 的话，中途失败会留下
// "消息更新了但工具调用只写了一半"的不一致状态。
// 所以 Rust 侧做成单事务复合命令 `messages.upsert_index`，这里只负责把行数据传过去。
//
// ## 为什么这次可以直接切（与只追加面不同）
//
// `createMessage` / `updateMessage` 的结构本来就是：
//   ① 权威日志（先写、必须成功）→ ② 索引（尽力而为、失败上报）
// 索引侧**已经很明确地是"best-effort + 可重建"**：失败会走 `reportPersistFailure`，
// 而数据不丢（权威副本在会话 JSONL 里）。
// 因此把 ② 换成"异步发往 Rust"不引入新的丢数据风险，也不产生读写分裂
// （读的是索引，索引的权威版本在 Rust；旧库那份只是过渡期缓存）。
//
// ## 返回 false 的含义
//
// 返回 false = "本次不接手，请调用方走原来的旧路径"。这样：
// - 端口未注册 / 引擎是 wasm（回滚开关）→ 完全维持原行为；
// - 读不到 base 行（更新路径）→ 回退到原路径，不猜数据。

type RustMessagePortLike = {
  data: { execute(cmd: string, params?: Record<string, unknown>): Promise<{ written: number }> };
  messages?: {
    isLoaded(sessionId: string): boolean;
    isTruncated(): boolean;
    ensureLoaded(sessionId: string, onLoaded?: () => void): void;
    list(sessionId: string): Array<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      reasoning?: string | null;
      timestamp: number;
      model?: string | null;
      status?: string | null;
      hidden?: number;
    }>;
    byIdLookup(id: string): { id: string; session_id: string } | undefined;
    hiddenIds(sessionId: string): Set<string>;
    count(sessionId: string): number;
  };
  applyMessageWrite?(row: Record<string, unknown> & { id: string; session_id: string }): void;
  applyMessageDelete?(sessionId: string, ids: string[]): void;
};

function rustMessagePort(): RustMessagePortLike | null {
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  if (port.kind !== "rust") return null;
  return port as unknown as RustMessagePortLike;
}

/**
 * 取某会话可用的 Rust 消息索引源 —— **未加载完就返回 null**（读写必须同处）。
 *
 * 这条规则与只追加面完全一致：只有该会话的索引**已完整加载**，才允许读写都走 Rust。
 * 否则继续用旧库那份（旧库的 hidden 状态虽然旧，但读写都在同一处，不会出现
 * "写进 Rust、读到的 hidden 是旧的"这种把压缩消息复活的情形）。
 *
 * 副作用：每次调用都会顺带触发一次惰性加载，因此最迟在该会话第二次访问时切过来。
 */
function rustMessageSource(sessionId: string): RustMessagePortLike | null {
  const port = rustMessagePort();
  if (!port?.messages) return null;
  port.messages.ensureLoaded(sessionId);
  if (!port.messages.isLoaded(sessionId)) return null;
  // 加载被上限截断时不能用镜像（集合不完整 → hidden 判定会错 → 可能复活消息）
  if (port.messages.isTruncated()) return null;
  return port;
}

/** 镜像行 → Message（与 SQLite 行映射保持同一语义） */
function messageRowToMessage(r: {
  id: string;
  session_id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  timestamp: number;
  model?: string | null;
  status?: string | null;
}): Message {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as Message["role"],
    content: r.content,
    ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    timestamp: r.timestamp,
    ...(r.model ? { model: r.model } : {}),
    status: (r.status ?? "done") as Message["status"],
  } as Message;
}

/** 工具调用 → 线协议形状（snake 字段、args/metadata 保留为对象由 Rust 侧序列化） */
function toolCallsForWire(message: Message): Array<Record<string, unknown>> | undefined {
  if (!message.toolCalls) return undefined; // 未提供：交给 Rust 侧"不动"
  return message.toolCalls.map((tc) => ({
    id: tc.id,
    tool: tc.tool,
    args: tc.args ?? {},
    result: tc.result ?? null,
    status: tc.status ?? "running",
    metadata: tc.metadata ?? null,
  }));
}

/**
 * 把一条完整消息行发往 Rust 索引（单事务）。
 * @returns true = 已接手（调用方不要再走旧路径）；false = 未接手
 */
function writeIndexViaRust(message: Message, sessionId: string, scope: "create" | "update"): boolean {
  const port = rustMessagePort();
  if (!port) return false;

  const params: Record<string, unknown> = {
    id: message.id,
    session_id: sessionId,
    role: message.role,
    content: message.content ?? "",
    reasoning: message.reasoning ?? null,
    timestamp: message.timestamp ?? Date.now(),
    model: message.model ?? null,
    status: message.status ?? "done",
    generated_files: message.generatedFiles ?? null,
    retrieved_sources: message.retrievedSources ?? null,
    tool_calls: toolCallsForWire(message),
  };

  void port.data
    .execute("messages.upsert_index", params)
    .then(() => {
      // 写入成功后把行同步进镜像 —— 否则"刚写的消息"在镜像里看不到（读写分裂的微观版本）
      port.applyMessageWrite?.({
        id: message.id,
        session_id: sessionId,
        role: message.role,
        content: message.content ?? "",
        reasoning: message.reasoning ?? null,
        timestamp: message.timestamp ?? Date.now(),
        model: message.model ?? null,
        status: message.status ?? "done",
      });
    })
    .catch((e) => {
      // 索引失败不阻塞、不抛：权威副本（会话 JSONL）已经写好，索引可由日志重建
      reportPersistFailure(
        `message.${scope}Message.index`,
        e,
        "消息已写入权威日志，但查询索引更新失败（索引可由日志重建）",
      );
    });
  return true;
}

/** 消息 → SQLite 索引（createMessage 的索引侧；失败由调用方兜底） */
function writeMessageIndex(message: Message, sessionId: string): void {
  // 迁移期分流：端口是 rust → 索引写走 Rust（**单事务**：主行 + JSON 列 + tool_calls 整体替换）
  if (writeIndexViaRust(message, sessionId, "create")) return;
  const db = getDatabase();
  // Check if message already exists
  const existing = db.exec("SELECT id FROM messages WHERE id = ?", [message.id]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    // Update existing message
    updateMessage(message.id, {
      content: message.content,
      reasoning: message.reasoning,
      model: message.model,
      status: message.status,
      toolCalls: message.toolCalls,
      generatedFiles: message.generatedFiles,
    });
    return;
  }

  db.run(
    "INSERT INTO messages (id, session_id, role, content, reasoning, timestamp, model, prompt_tokens, completion_tokens, cost, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      message.id,
      sessionId,
      message.role,
      message.content,
      message.reasoning ?? null,
      message.timestamp,
      message.model ?? null,
      0,
      0,
      0,
      message.status ?? "done",
    ]
  );

  // Update generated_files separately to avoid INSERT failure if column missing
  if (message.generatedFiles && message.generatedFiles.length > 0) {
    try {
      runGuarded(db, "UPDATE messages SET generated_files = ? WHERE id = ?", [JSON.stringify(message.generatedFiles), message.id],
        { table: "messages", op: "set-generated-files", id: message.id, from: "createMessage" });
    } catch (e) {
      console.warn("[createMessage] generated_files column may not exist:", e);
    }
  }

  // Persist retrieved_sources (auto-retrieved knowledge citations)
  if (message.retrievedSources && message.retrievedSources.length > 0) {
    try {
      runGuarded(db, "UPDATE messages SET retrieved_sources = ? WHERE id = ?", [JSON.stringify(message.retrievedSources), message.id],
        { table: "messages", op: "set-retrieved-sources", id: message.id, from: "createMessage" });
    } catch (e) {
      console.warn("[createMessage] retrieved_sources column may not exist:", e);
    }
  }

  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      db.run(
        "INSERT INTO tool_calls (id, message_id, tool, args, result, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [tc.id, message.id, tc.tool, JSON.stringify(tc.args), tc.result ?? null, tc.status, tc.metadata ? JSON.stringify(tc.metadata) : null]
      );
    }
  }

  // Persist attachments associated with this message
  if (message.attachments && message.attachments.length > 0) {
    for (const att of message.attachments) {
      try {
        // 第 80 波：大附件内容外置到 <appData>/attachments/，库里只留 file:<路径> 标记 + 预览。
        // 小内容（图片 data URL、短文本）保持内联 —— 常见场景行为不变。
        const stored = externalizeIfLargeSync(att);
        db.run(
          "INSERT OR REPLACE INTO attachments (id, session_id, message_id, name, type, path, content, preview, sandbox_path, mime_type, size, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            att.id,
            sessionId,
            message.id,
            att.name,
            att.type,
            (att as any).path ?? null,
            stored.content,
            stored.preview,
            att.sandboxPath ?? null,
            att.mimeType ?? null,
            att.size ?? null,
            Date.now(),
          ]
        );
      } catch (e) {
        console.warn("[createMessage] Failed to save attachment:", e);
      }
    }
  }
  // ========== P0-1: Event Sourcing dual-write ==========
  // Append events to the event log alongside the CRUD write.
  // This enables gradual migration: buildMessages() can read from
  // either the old CRUD or the new event projection.
  try {
    const eventLog = getEventLog();
    if (message.role === "user") {
      eventLog.append(sessionId, "user_message", {
        messageId: message.id,
        content: message.content,
      });
    } else if (message.role === "assistant") {
      if (message.content) {
        eventLog.append(sessionId, "assistant_text", {
          messageId: message.id,
          content: message.content,
          model: message.model,
        });
      }
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          eventLog.append(sessionId, "tool_call", {
            toolCallId: tc.id,
            messageId: message.id,
            tool: tc.tool,
            args: tc.args,
            status: tc.status,
          });
          if (tc.result) {
            eventLog.append(sessionId, "tool_result", {
              toolCallId: tc.id,
              messageId: message.id,
              result: tc.result,
              status: "completed",
            });
          }
        }
      }
    }

    // Also index in FTS5 for session search (P1-7)
    if (isFts5Available()) {
      try {
        const db = getDatabase();
        db.run(
          "INSERT INTO session_fts (session_id, message_id, content, role, timestamp) VALUES (?, ?, ?, ?, ?)",
          [sessionId, message.id, message.content, message.role, message.timestamp],
        );
      } catch (ftsErr) {
        // FTS5 table might not exist in older databases — non-critical
        console.warn("[createMessage] FTS indexing failed (non-critical):", ftsErr);
      }
    }
  } catch (eventErr) {
    console.warn("[createMessage] Event log dual-write failed (non-critical):", eventErr);
  }

  persistDatabase();
  // 第 78 波：**权威日志是追加式 JSONL**（对齐 DSH 的 session-persistence-jsonl），
  // SQLite 退化为"可重建的查询索引"。这条追加已由 createMessage 在**索引之前**完成（第 91 波）。
}

/**
 * 更新一条消息。
 *
 * 第 91 波（架构级）：与 createMessage 同一处修正 —— **先写权威日志，再更新索引**。
 *
 * 快照的来源优先用**日志镜像/索引里的现存消息**（不依赖"索引还能用"）；两者都取不到时
 * 才退回老的"从索引读一遍再追加"路径（那样在索引崩掉时确实写不进日志，但至少不会写坏）。
 */
export function updateMessage(id: string, update: Partial<Message>): void {
  // ① 权威日志：先用现有快照 + 本次改动合成一条完整记录追加（同 id 后写者胜）
  const sessionId = currentSessionIdForMessage(id);
  if (sessionId) {
    const base = logMirrorMessage(sessionId, id) ?? (isDatabaseFatal() ? null : safeGetMessage(id));
    if (base) {
      void appendSessionMessage(sessionId, { ...base, ...update, id, timestamp: base.timestamp ?? Date.now() } as Message);
    } else {
      void appendUpdatedMessageToLog(id);
    }
  } else {
    void appendUpdatedMessageToLog(id);
  }

  // ② 索引：尽力而为
  if (isDatabaseFatal()) return;
  try {
    writeMessageUpdateIndex(id, update);
  } catch (e) {
    if (!noteDatabaseError(e)) {
      reportPersistFailure("message.updateMessage.index", e, "消息改动已写入权威日志，但查询索引更新失败（索引可由日志重建）");
    }
  }
}

/** 索引不可用时的安全读取（不抛） */
function safeGetMessage(id: string): Message | null {
  try {
    return getMessage(id);
  } catch {
    return null;
  }
}

/** 消息更新 → SQLite 索引（updateMessage 的索引侧；失败由调用方兜底） */
function writeMessageUpdateIndex(id: string, update: Partial<Message>): void {
  // 迁移期分流：端口是 rust → 走单事务复合写
  const base = isDatabaseFatal() ? null : safeGetMessage(id);
  const sid = base ? currentSessionIdForMessage(id) : null;
  if (base && sid && writeIndexViaRust({ ...base, ...update, id } as Message, sid, "update")) return;
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.content !== undefined) { fields.push("content = ?"); values.push(update.content); }
  if (update.reasoning !== undefined) { fields.push("reasoning = ?"); values.push(update.reasoning); }
  if (update.model !== undefined) { fields.push("model = ?"); values.push(update.model ?? null); }
  if (update.status !== undefined) { fields.push("status = ?"); values.push(update.status ?? "done"); }

  if (fields.length > 0) {
    values.push(id);
    try {
      // 第 83 波：这条 UPDATE 曾经**静默**影响 0 行 —— 后台执行路径只换内存 id 不建行，
      // 于是第 2 轮之后的正文/工具结果全部无声丢失（真机表现：会话原地打转、父会话干等）。
      // 现在走 runGuarded：写不到行就记账并告警一次，让"静默失败"变成"响"。
      runGuarded(db, `UPDATE messages SET ${fields.join(", ")} WHERE id = ?`, values, {
        table: "messages", op: "update", id, from: "updateMessage",
      });
    } catch (e) {
      console.error("[updateMessage] Failed to update:", e);
    }
  }

  // Handle generated_files separately to avoid failure if column missing
  if (update.generatedFiles !== undefined) {
    try {
      runGuarded(db, "UPDATE messages SET generated_files = ? WHERE id = ?", [update.generatedFiles ? JSON.stringify(update.generatedFiles) : null, id],
        { table: "messages", op: "set-generated-files", id, from: "updateMessage" });
    } catch (e) {
      console.warn("[updateMessage] generated_files column may not exist:", e);
    }
  }

  // Handle retrieved_sources separately to avoid failure if column missing
  if (update.retrievedSources !== undefined) {
    try {
      runGuarded(db, "UPDATE messages SET retrieved_sources = ? WHERE id = ?", [update.retrievedSources ? JSON.stringify(update.retrievedSources) : null, id],
        { table: "messages", op: "set-retrieved-sources", id, from: "updateMessage" });
    } catch (e) {
      console.warn("[updateMessage] retrieved_sources column may not exist:", e);
    }
  }

  if (update.toolCalls !== undefined) {
    db.run("DELETE FROM tool_calls WHERE message_id = ?", [id]);
    for (const tc of update.toolCalls) {
      db.run(
        "INSERT INTO tool_calls (id, message_id, tool, args, result, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [tc.id, id, tc.tool, JSON.stringify(tc.args), tc.result ?? null, tc.status, tc.metadata ? JSON.stringify(tc.metadata) : null]
      );
    }
  }
  persistDatabase();
  // 更新也进追加日志（同 id 后写者胜）—— 该追加已由 updateMessage 在**索引之前**完成（第 91 波）
}

/**
 * 把"当前索引里的这一条消息"追加进日志（更新路径用）。
 *
 * 审计修正（第 79 波）：这里以前靠 `getMessage(id)` 取 sessionId —— 而 `getMessage`
 * 返回的 Message **不含 session id**（UI 侧本来也不关心它），于是 `sessionId` 一直是 undefined，
 * 更新路径**从未真正写入日志**：日志里只有 createMessage 时的初版内容，
 * 流式回复/工具结果的最新版本只存在于索引里 —— 一旦索引被裁剪或重建，内容就会**回退**。
 * 现在直接查一次库拿 session_id（和删除路径同源），并在查不到时明确告警。
 */
async function appendUpdatedMessageToLog(id: string): Promise<void> {
  try {
    const sessionId = currentSessionIdForMessage(id);
    if (!sessionId) {
      console.warn(`[SessionJSONL] 更新消息 ${id} 时找不到所属会话，日志未更新（索引仍是最新）`);
      return;
    }
    const message = getMessage(id);
    if (!message) return;
    await appendSessionMessage(sessionId, message);
  } catch (e) {
    console.warn("[SessionJSONL] 更新消息追加日志失败（索引仍在）:", e);
  }
}

export function appendToMessage(id: string, content: string): void {
  const db = getDatabase();
  runGuarded(db, "UPDATE messages SET content = content || ? WHERE id = ?", [content, id],
    { table: "messages", op: "append-content", id, from: "appendMessageContent" });
  persistDatabase();
}

export function addToolCall(messageId: string, toolCall: ToolCall): void {
  const db = getDatabase();
  db.run(
    "INSERT OR REPLACE INTO tool_calls (id, message_id, tool, args, result, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [toolCall.id, messageId, toolCall.tool, JSON.stringify(toolCall.args), toolCall.result ?? null, toolCall.status, toolCall.metadata ? JSON.stringify(toolCall.metadata) : null]
  );
  persistDatabase();
}

export function updateToolCall(messageId: string, toolId: string, update: Partial<ToolCall>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.args !== undefined) { fields.push("args = ?"); values.push(JSON.stringify(update.args)); }
  if (update.result !== undefined) { fields.push("result = ?"); values.push(update.result ?? null); }
  if (update.status !== undefined) { fields.push("status = ?"); values.push(update.status); }
  if (update.metadata !== undefined) { fields.push("metadata = ?"); values.push(update.metadata ? JSON.stringify(update.metadata) : null); }

  if (fields.length > 0) {
    values.push(toolId);
    /**
     * 第 83 波：工具结果写不到行 = **模型看不到自己这次调用的结果** ——
     * 那正是"反复重发同一个工具调用"的直接诱因（用户现场：同一个脚本跑几十遍）。
     * 所以这里必须能被发现（影响 0 行 → 记账 + 告警）。
     */
    runGuarded(
      db,
      `UPDATE tool_calls SET ${fields.join(", ")} WHERE id = ? AND message_id = ?`,
      [...values, messageId],
      { table: "tool_calls", op: "update", id: toolId, from: "updateToolCall" },
    );
  }
  persistDatabase();
}

export function deleteMessage(id: string): void {
  const db = getDatabase();
  // 先取会话 id（删掉之后就查不到了）：墓碑需要它
  const sessionId = currentSessionIdForMessage(id);
  db.run("DELETE FROM messages WHERE id = ?", [id]);
  persistDatabase();
  if (sessionId) void appendMessageTombstone(sessionId, id);
}

/** 查一条消息属于哪个会话（删除前调用） */
function currentSessionIdForMessage(messageId: string): string | null {
  try {
    const rows = getDatabase().exec("SELECT session_id FROM messages WHERE id = ?", [messageId]);
    const value = rows?.[0]?.values?.[0]?.[0];
    if (value) return String(value);
  } catch {
    /* 索引不可用 → 走日志镜像兜底（第 91 波） */
  }
  return sessionIdFromLogMirror(messageId);
}

/**
 * 批量删除后补墓碑（第 78 波）。
 *
 * 为什么所有删除路径都要走这里：日志是权威存储、索引可重建 —— 任何"只删索引不记日志"的删除，
 * 都会在下次从日志合并/重建时**复活**（压缩、清理旧消息、按范围删除都属于这条路径）。
 */
function appendTombstonesFor(sessionId: string, ids: string[]): void {
  if (!sessionId || ids.length === 0) return;
  /**
   * 第 83 波：这里原来是 `await import("./session-jsonl")` 之后再写 ——
   * 本文件顶部**早就**静态 import 了 `appendMessageTombstone`，动态 import 纯属多余；
   * 更糟的是它把写入推迟到微任务之后，`flushSessionLogWrites()` 看不到这些在途写入
   * （墓碑现在会登记在途状态），"删完立刻 flush 再读日志"就可能读到旧内容。
   * 现在直接同步发起，全部登记进日志的在途集合。
   */
  for (const id of ids) {
    void appendMessageTombstone(sessionId, id);
  }
}

/** Delete all messages before a given timestamp (exclusive) in a session */
export function deleteMessagesBefore(sessionId: string, timestamp: number): number {
  const db = getDatabase();
  // First get the IDs of messages to delete (so we can clean up tool_calls)
  const result = db.exec(
    "SELECT id FROM messages WHERE session_id = ? AND timestamp < ?",
    [sessionId, timestamp]
  );
  if (result.length === 0) return 0;
  const ids = result[0].values.map((row: any[]) => row[0] as string);

  // Delete tool_calls for those messages
  for (const id of ids) {
    db.run("DELETE FROM tool_calls WHERE message_id = ?", [id]);
  }
  // Delete the messages
  db.run(
    "DELETE FROM messages WHERE session_id = ? AND timestamp < ?",
    [sessionId, timestamp]
  );
  persistDatabase();
  // 真删除必须留墓碑（否则下次从权威日志重建会复活）
  appendTombstonesFor(sessionId, ids);
  return ids.length;
}

/**
 * 批量删除（上下文压缩走这条路径）。
 *
 * ## 第 83 波：这里曾经是个**致命的假删除**（用户现场）
 *
 * 原来只做 `UPDATE messages SET hidden = 1`（索引侧软删除），**不写权威日志**。
 * 而读路径 `listMessages` = 索引(WHERE hidden=0) ∪ 缓存日志 —— 日志里根本没有 hidden 语义，
 * 于是被"删掉"的消息**被日志整批加回来，而且不带 hidden**：
 *
 *   · 压缩说"移除 840 条"，下一次读又回来 840 条 → 上下文 token 一点没降；
 *   · 每次迭代都重新压缩一遍（LLM 摘要调用白烧），最后硬停"请开启新对话"。
 *   · 用户现场日志：`Removed 840/841 … kept 20`，请求恒为 ~105 万 token，迭代 1→2→3→4 循环。
 *
 * 修法与其它删除路径一致（`deleteMessage` / `deleteMessagesBefore` 早就这么做了）：
 * **删除必须同时落到索引与权威日志**（墓碑 + 后写者胜），并且把内存镜像里的同 id 记录清掉 ——
 * 镜像不刷新的话，本进程内的合并仍会从缓存里"复活"这些消息。
 */
export function deleteMessagesByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDatabase();
  // 先按会话分组（墓碑要写进对应会话的日志），再软删除索引行
  const bySession = sessionIdsForMessages(ids);
  for (const id of ids) {
    // 墓碑（hide）路径：0 行 = 这条消息根本不在索引里 —— 正是"假压缩"事故的观测点
    runGuarded(db, "UPDATE messages SET hidden = 1 WHERE id = ?", [id],
      { table: "messages", op: "hide", id, from: "deleteMessagesByIds" });
  }
  persistDatabase();
  // 权威日志：逐条留墓碑（后写者胜：之后再写入同 id 即为重新出现）
  for (const [sid, sids] of bySession) {
    appendTombstonesFor(sid, sids);
    // 内存镜像同步剔除：否则本次进程内的 listMessages 仍会从镜像复活这些消息
    dropFromLogMirror(sid, sids);
  }
  return ids.length;
}

/** 把一批消息 id 按所属会话分组（分块查询，避免超长 IN 子句） */
function sessionIdsForMessages(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const marks = chunk.map(() => "?").join(",");
      const rows = getDatabase().exec(
        `SELECT id, session_id FROM messages WHERE id IN (${marks})`,
        chunk,
      );
      for (const row of rows?.[0]?.values ?? []) {
        const id = String(row[0]);
        const sid = String(row[1]);
        if (!sid) continue;
        const list = out.get(sid);
        if (list) list.push(id);
        else out.set(sid, [id]);
      }
    } catch (e) {
      console.warn("[Storage] 查询消息所属会话失败（跳过墓碑写入）:", e);
    }
  }
  return out;
}

/** 从日志内存镜像里剔除若干 id（删除/隐藏后必须调用） */
function dropFromLogMirror(sessionId: string, ids: string[]): void {
  const cached = cachedLogMessages.get(sessionId);
  if (!cached || cached.length === 0) return;
  const drop = new Set(ids);
  const kept = cached.filter((rec) => !drop.has(rec.id));
  if (kept.length !== cached.length) cachedLogMessages.set(sessionId, kept);
}

export function getMessageCount(sessionId: string): number {
  const routed = rustMessageSource(sessionId);
  if (routed?.messages) return routed.messages.count(sessionId);
  const db = getDatabase();
  const result = db.exec("SELECT COUNT(*) FROM messages WHERE session_id = ?", [sessionId]);
  if (result.length === 0) return 0;
  return result[0].values[0][0] as number;
}

// ========== P0: Message Feedback (like / dislike) ==========

export type FeedbackType = "like" | "dislike";

export interface FeedbackRecord {
  id: string;
  messageId: string;
  sessionId: string;
  feedback: FeedbackType;
  timestamp: number;
}

/** Save or update feedback for a message. Passing null removes the feedback. */
/**
 * 反馈的内存缓存（P3 第 9 段）。
 *
 * ## 为什么用"写穿缓存"而不是整表加载
 *
 * `loadFeedback` 是**同步**接口，而 Rust 是异步 IPC。反馈表很小（一条消息最多一行），
 * 但没有"按会话"的天然边界 —— 一条消息的反馈可能在任何会话里被查询。
 * 整表加载会引入一个不必要的启动读；而**只缓存本进程写过的**就足够：
 *
 * - 写入走 Rust（权威），并同步进缓存 → 本进程内的读立即可见；
 * - 缓存里没有的（历史反馈）→ 继续读旧库（那里是迁移前的数据，且读与写都在同一处）。
 *
 * 这条规则与只追加面/消息镜像同源：**只有当读与写落在同一处时才切换**。
 * 旧库那份反馈值虽然会随时间变旧，但"没写过的消息"的反馈本来就没被本进程改动过。
 */
const feedbackCache = new Map<string, FeedbackType | null>();

/** 反馈写入是否走 Rust（端口可用时的分流判据） */
function rustFeedbackPort(): RustMessagePortLike | null {
  const port = rustMessagePort();
  return port?.data ? port : null;
}

export function saveFeedback(messageId: string, sessionId: string, feedback: FeedbackType | null): void {
  const port = rustFeedbackPort();
  if (port) {
    // 先内存后落库：本进程内读立即可见，落库失败如实上报
    feedbackCache.set(messageId, feedback);
    void port.data
      .execute("feedback.set", { message_id: messageId, session_id: sessionId, feedback })
      .catch((e) => {
        reportPersistFailure("message.saveFeedback", e, "反馈未保存，重启后会丢失");
      });
    return;
  }
  const db = getDatabase();
  // Delete existing feedback for this message
  try {
    db.run("DELETE FROM message_feedback WHERE message_id = ?", [messageId]);
  } catch (e) {
    reportPersistFailure("message.saveFeedback.clearExisting", e, "旧的反馈未清除，可能写入重复反馈");
  }
  if (feedback) {
    const id = `fb-${messageId}`;
    try {
      db.run(
        "INSERT INTO message_feedback (id, message_id, session_id, feedback, timestamp) VALUES (?, ?, ?, ?, ?)",
        [id, messageId, sessionId, feedback, Date.now()]
      );
    } catch (e) {
      console.warn("[saveFeedback] Failed to insert:", e);
    }
  }
  persistDatabase();
}

/** Load feedback for a specific message. Returns 'like', 'dislike', or null. */
export function loadFeedback(messageId: string): FeedbackType | null {
  // 本进程写过的优先（与写入落在同一处：都走 Rust）
  if (feedbackCache.has(messageId)) return feedbackCache.get(messageId) ?? null;
  // 数据库致命状态下直接返回（不再每次撞已崩的堆、也不再刷屏）
  if (isDatabaseFatal()) return null;
  const db = getDatabase();
  try {
    const result = db.exec("SELECT feedback FROM message_feedback WHERE message_id = ?", [messageId]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0][0] as FeedbackType;
  } catch (e) {
    if (!noteDatabaseError(e)) console.warn("[loadFeedback] Failed:", e);
    return null;
  }
}

// ========== P0: Delete Messages After (for inline edit & resend) ==========

/**
 * Delete a message and ALL messages that come after it in the same session.
 * This is used by the inline-edit-and-resend feature: the user edits a message,
 * and everything from that point onwards is deleted so the conversation can
 * be re-run from the edited message.
 *
 * @returns the number of messages deleted (including the target message itself if includeSelf=true)
 */
export function deleteMessagesAfter(
  sessionId: string,
  messageId: string,
  options?: { includeSelf?: boolean }
): number {
  const db = getDatabase();
  const includeSelf = options?.includeSelf ?? false;

  // Get the timestamp of the target message
  const tsResult = db.exec(
    "SELECT timestamp FROM messages WHERE id = ? AND session_id = ?",
    [messageId, sessionId]
  );
  if (tsResult.length === 0 || tsResult[0].values.length === 0) return 0;
  const targetTimestamp = tsResult[0].values[0][0] as number;

  // Build the query: delete messages after (and optionally including) the target
  const op = includeSelf ? ">=" : ">";
  const result = db.exec(
    `SELECT id FROM messages WHERE session_id = ? AND timestamp ${op} ?`,
    [sessionId, targetTimestamp]
  );
  if (result.length === 0) return 0;
  const ids = result[0].values.map((row: any[]) => row[0] as string);

  // Delete tool_calls and messages for those IDs
  for (const id of ids) {
    db.run("DELETE FROM tool_calls WHERE message_id = ?", [id]);
    db.run("DELETE FROM message_feedback WHERE message_id = ?", [id]);
  }
  db.run(
    `DELETE FROM messages WHERE session_id = ? AND timestamp ${op} ?`,
    [sessionId, targetTimestamp]
  );
  persistDatabase();
  /**
   * 第 83 波（审计修正）：这是**唯一一条删了索引却不写墓碑、不清内存镜像**的删除路径
   * （其它删除路径都做了 —— 见 `appendTombstonesFor` 的说明）。后果：
   * 用户"编辑并重发"之后，被删掉的旧回复会在下一次 `listMessages` 合并时
   * **从权威日志里整批复活**（读路径以日志为准），而函数仍然返回"删了 N 条"。
   */
  appendTombstonesFor(sessionId, ids);
  dropFromLogMirror(sessionId, ids);
  return ids.length;
}

/**
 * Update a user message's content (for inline edit).
 * This updates the content in-place without deleting the message.
 */
export function updateMessageContent(messageId: string, content: string): void {
  const db = getDatabase();
  runGuarded(db, "UPDATE messages SET content = ? WHERE id = ?", [content, messageId],
    { table: "messages", op: "set-content", id: messageId, from: "updateMessageContent" });
  persistDatabase();
}

// ========== Agentic Loop Helper Functions ==========

export function appendMessageContent(id: string, text: string): void {
  const db = getDatabase();
  runGuarded(db, "UPDATE messages SET content = content || ? WHERE id = ?", [text, id],
    { table: "messages", op: "append-content", id, from: "appendToMessageContent" });
  persistDatabase();
}

export function setMessageContent(id: string, content: string): void {
  const db = getDatabase();
  runGuarded(db, "UPDATE messages SET content = ? WHERE id = ?", [content, id],
    { table: "messages", op: "set-content", id, from: "updateMessageFullContent" });
  persistDatabase();
}

export function setMessageReasoning(id: string, reasoning: string): void {
  const db = getDatabase();
  try {
    runGuarded(db, "UPDATE messages SET reasoning = ? WHERE id = ?", [reasoning, id],
    { table: "messages", op: "set-reasoning", id, from: "updateMessageReasoning" });
  } catch (e) {
    reportPersistFailure("message.setMessageReasoning", e);
  }
  persistDatabase();
}

export function setMessageStatus(id: string, status: string): void {
  const db = getDatabase();
  runGuarded(db, "UPDATE messages SET status = ? WHERE id = ?", [status, id],
    { table: "messages", op: "set-status", id, from: "updateMessageStatus" });
  persistDatabase();
}

// ========== Convert Message to LLM API format ==========

function stripSystemReminders(content: string): string {
  // Remove <system-reminder>...</system-reminder> tags injected by MiMoCode CLI
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "audio"; mediaType: string; data: string };

export interface LLMMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
  /**
   * DeepSeek thinking mode: reasoning_content must be round-tripped back to the
   * API on historical assistant messages (HTTP 400 otherwise). Stored in DB
   * `messages.reasoning`; passed to provider.toAPIMessage as `reasoning_content`.
   */
  reasoning?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export function messagesToLLMMessages(messages: Message[]): LLMMessage[] {
  const result: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const cleanContent = stripSystemReminders(msg.content || "(empty)");
      if (!cleanContent) continue;

      // Check for media attachments (image/audio) — generate ContentBlock[] for multimodal
      const mediaAttachments = (msg.attachments || []).filter(
        (a) => (a.type === "image" || a.type === "audio") && a.content
      );
      if (mediaAttachments.length > 0) {
        const blocks: ContentBlock[] = [
          { type: "text", text: cleanContent },
        ];
        for (const att of mediaAttachments) {
          let base64Data = att.content || "";
          const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,(.+)$/);
          const mediaType = dataUrlMatch ? dataUrlMatch[1] : (att.mimeType || (att.type === "audio" ? "audio/mpeg" : "image/png"));
          const rawData = dataUrlMatch ? dataUrlMatch[2] : base64Data;
          blocks.push({
            type: att.type === "audio" ? "audio" : "image",
            mediaType,
            data: rawData,
          });
        }
        result.push({
          id: msg.id,
          role: "user",
          content: blocks,
        });
      } else {
        result.push({
          id: msg.id,
          role: "user",
          content: cleanContent,
        });
      }
    } else if (msg.role === "assistant") {
      const toolCalls = msg.toolCalls || [];
      const completedTools = toolCalls.filter((t) => t.status === "done" || t.status === "error");

      // Build content: text only (reasoning_content is a separate field for DeepSeek)
      let content = stripSystemReminders(msg.content || "");

      // Include the assistant message if it has text content OR any completed tool calls.
      // Previously this was all-or-nothing: if ANY tool call was still "running",
      // ALL tool calls and results were excluded. This caused the LLM to lose
      // visibility of previous tool results (e.g., wait_for_subagent results),
      // leading to infinite loops where the LLM repeatedly called the same tool.
      //
      // Now: only include COMPLETED tool calls and their results. Running/pending
      // tool calls are simply omitted — they'll be included in the next iteration
      // once they complete.
      if (content || completedTools.length > 0) {
        const assistantMsg: LLMMessage = {
          id: msg.id,
          role: "assistant",
          content,
        };
        // DeepSeek thinking mode REQUIRES round-tripping reasoning_content:
        // DeepSeek V4 (thinking mode) rejects requests where a previous
        // assistant message's reasoning_content is omitted — HTTP 400
        // "The `reasoning_content` in the thinking mode must be passed back
        // to the API." (multi-turn tool-call conversations trigger this).
        // DB `messages.reasoning` was previously stripped here (fear of the
        // LLM treating old reasoning as instructions), but the API now
        // enforces it. Reasoning is still displayed in UI; it is also passed
        // back verbatim as `reasoning_content` for API compatibility.
        if (msg.reasoning) {
          assistantMsg.reasoning = msg.reasoning;
        }
        if (completedTools.length > 0) {
          assistantMsg.tool_calls = completedTools.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.tool,
              arguments: JSON.stringify(tc.args || {}),
            },
          }));
        }
        result.push(assistantMsg);
      }

      // Add tool results for completed tools only
      for (const tc of completedTools) {
        const cleanResult = stripSystemReminders(tc.result || "(no output)");
        result.push({
          id: `${msg.id}-tool-${tc.id}`,
          role: "tool",
          content: cleanResult,
          toolCallId: tc.id,
        });
      }
    }
    // Skip system messages (they're handled separately)
  }

  // Remove orphan tool messages
  const cleaned: LLMMessage[] = [];
  let lastAssistantWithToolCalls = false;
  for (const msg of result) {
    if (msg.role === "assistant") {
      lastAssistantWithToolCalls = !!(msg as any).tool_calls;
      cleaned.push(msg);
    } else if (msg.role === "tool") {
      if (lastAssistantWithToolCalls) {
        cleaned.push(msg);
      }
    } else {
      lastAssistantWithToolCalls = false;
      cleaned.push(msg);
    }
  }

  return cleaned;
}
