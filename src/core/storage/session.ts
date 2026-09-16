import { getDatabase, persistDatabase, tryGetDatabase } from "./database";
import { getEventLog } from "./event-log";
import type { Session } from "../types";
import { runGuarded } from "./write-guard";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

/**
 * `sessions` 域接入端口（P5 第 4 段）。
 *
 * ## 为什么这一段是"必须补"而不是"顺手接"
 *
 * P5 第 4 段把启动路径改成"引擎为 rust 时不加载 WASM 库"之后，真机复验发现：
 * **这个文件一个端口调用都没有** —— 创建会话、改标题、置顶、删除、fork、拖拽排序
 * 全都还在打旧库。旧库不加载之后这些操作会直接失败，而这是最核心的一条用户路径。
 *
 * ## 各函数的语义要点
 *
 * - `sessions` 表**没有** `updated_at` 列（时间列是 `last_message_at`）；
 * - 一批列是 ALTER 加的（execution_mode / worktree_* / *_mode / parent_id / sort_order），
 *   整体 upsert 时必须**显式列全**，否则会被写成 NULL；
 * - `listSessions` 排序是 `pinned DESC, last_message_at DESC`；
 * - `reorderSessions` 只改 `sort_order`，不能顺手改别的列。
 */
const SESSION_TABLE = "sessions";

function wireToSession(row: Record<string, unknown>): Session {
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    title: String(row.title ?? ""),
    model: (row.model as string) ?? undefined,
    createdAt: Number(row.created_at ?? 0),
    lastMessageAt: Number(row.last_message_at ?? 0),
    messageCount: Number(row.message_count ?? 0),
    pinned: Number(row.pinned ?? 0) === 1,
    executionMode: (row.execution_mode as Session["executionMode"]) ?? undefined,
    worktreePath: (row.worktree_path as string) ?? undefined,
    worktreeBranch: (row.worktree_branch as string) ?? undefined,
    correctionMode: (row.correction_mode as number) ?? undefined,
    deepThinkingMode: (row.deep_thinking_mode as number) ?? undefined,
    preserveExecutor: (row.preserve_executor as number) ?? undefined,
  };
}

/** `Session` → 线协议行。可选列**必须显式写 null**，否则"清空某列"写不进去。 */
function sessionToWire(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    project_id: s.projectId,
    title: s.title,
    model: s.model ?? null,
    created_at: s.createdAt,
    last_message_at: s.lastMessageAt,
    message_count: s.messageCount,
    pinned: s.pinned ? 1 : 0,
    execution_mode: s.executionMode ?? null,
    worktree_path: s.worktreePath ?? null,
    worktree_branch: s.worktreeBranch ?? null,
    correction_mode: s.correctionMode ?? null,
    deep_thinking_mode: s.deepThinkingMode ?? null,
    preserve_executor: s.preserveExecutor ?? null,
  };
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  model: string | null;
  created_at: number;
  last_message_at: number;
  message_count: number;
  pinned: number;
  execution_mode?: string | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
  correction_mode?: number | null;
  deep_thinking_mode?: number | null;
  preserve_executor?: number | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    pinned: row.pinned === 1,
    executionMode: (row.execution_mode as Session["executionMode"]) ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
    correctionMode: row.correction_mode ?? undefined,
    deepThinkingMode: row.deep_thinking_mode ?? undefined,
    preserveExecutor: row.preserve_executor ?? undefined,
  };
}

function rowToSessionFromAny(row: any[]): Session {
  return rowToSession({
    id: row[0] as string,
    project_id: row[1] as string,
    title: row[2] as string,
    model: row[3] as string | null,
    created_at: row[4] as number,
    last_message_at: row[5] as number,
    message_count: row[6] as number,
    pinned: row[7] as number,
    correction_mode: row[8] as number | null,
    deep_thinking_mode: row[9] as number | null,
    preserve_executor: row[10] as number | null,
    execution_mode: row[11] as string | null,
    worktree_path: row[12] as string | null,
    worktree_branch: row[13] as string | null,
  });
}


export function listSessions(projectId: string): Session[] {
  const rust = domainReadMany(SESSION_TABLE, wireToSession, { project_id: projectId });
  if (rust) {
    // 旧 SQL：ORDER BY pinned DESC, last_message_at DESC
    return rust.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      return pa !== pb ? pb - pa : b.lastMessageAt - a.lastMessageAt;
    });
  }
  const db = tryGetDatabase();
  if (!db) return [];
  const result = db.exec(
    "SELECT * FROM sessions WHERE project_id = ? ORDER BY pinned DESC, last_message_at DESC",
    [projectId]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSessionFromAny);
}

export function getSession(id: string): Session | null {
  const rust = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rust !== undefined) return rust;
  const db = tryGetDatabase();
  if (!db) return null;
  const result = db.exec("SELECT * FROM sessions WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToSessionFromAny(result[0].values[0]);
}

export function createSession(session: Session): void {
  if (domainWrite(SESSION_TABLE, [sessionToWire(session)], { scope: "session.create", note: "会话未保存" })) {
    return;
  }
  const db = tryGetDatabase();
  if (!db) return;
  db.run(
    "INSERT INTO sessions (id, project_id, title, model, created_at, last_message_at, message_count, pinned, execution_mode, worktree_path, worktree_branch, correction_mode, deep_thinking_mode, preserve_executor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      session.id,
      session.projectId,
      session.title,
      session.model ?? null,
      session.createdAt,
      session.lastMessageAt,
      session.messageCount,
      session.pinned ? 1 : 0,
      session.executionMode ?? null,
      session.worktreePath ?? null,
      session.worktreeBranch ?? null,
      session.correctionMode ?? null,
      session.deepThinkingMode ?? null,
      session.preserveExecutor ?? null,
    ]
  );
  persistDatabase();
}

export function updateSession(id: string, update: Partial<Session>): void {
  const hasAnyField =
    update.title !== undefined || update.model !== undefined || update.lastMessageAt !== undefined ||
    update.messageCount !== undefined || update.pinned !== undefined || update.executionMode !== undefined ||
    update.worktreePath !== undefined || update.worktreeBranch !== undefined ||
    update.correctionMode !== undefined || update.deepThinkingMode !== undefined ||
    update.preserveExecutor !== undefined;
  if (!hasAnyField) return;

  // 迁移期：读出整行 → 应用改动 → 整体写回（未改动列必须保留）
  const rustCurrent = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rustCurrent !== undefined) {
    if (!rustCurrent) return; // 会话不存在：旧实现是 UPDATE 影响 0 行
    const next: Session = {
      ...rustCurrent,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.model !== undefined ? { model: update.model ?? undefined } : {}),
      ...(update.lastMessageAt !== undefined ? { lastMessageAt: update.lastMessageAt } : {}),
      ...(update.messageCount !== undefined ? { messageCount: update.messageCount } : {}),
      ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
      ...(update.executionMode !== undefined ? { executionMode: update.executionMode ?? undefined } : {}),
      ...(update.worktreePath !== undefined ? { worktreePath: update.worktreePath ?? undefined } : {}),
      ...(update.worktreeBranch !== undefined ? { worktreeBranch: update.worktreeBranch ?? undefined } : {}),
      ...(update.correctionMode !== undefined ? { correctionMode: update.correctionMode ?? undefined } : {}),
      ...(update.deepThinkingMode !== undefined ? { deepThinkingMode: update.deepThinkingMode ?? undefined } : {}),
      ...(update.preserveExecutor !== undefined ? { preserveExecutor: update.preserveExecutor ?? undefined } : {}),
    };
    domainWrite(SESSION_TABLE, [sessionToWire(next)], {
      mode: "replace",
      scope: "session.update",
      note: "会话未更新（会话不存在或写入失败）",
    });
    return;
  }

  const db = tryGetDatabase();
  if (!db) return;
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.title !== undefined) { fields.push("title = ?"); values.push(update.title); }
  if (update.model !== undefined) { fields.push("model = ?"); values.push(update.model ?? null); }
  if (update.lastMessageAt !== undefined) { fields.push("last_message_at = ?"); values.push(update.lastMessageAt); }
  if (update.messageCount !== undefined) { fields.push("message_count = ?"); values.push(update.messageCount); }
  if (update.pinned !== undefined) { fields.push("pinned = ?"); values.push(update.pinned ? 1 : 0); }
  if (update.executionMode !== undefined) { fields.push("execution_mode = ?"); values.push(update.executionMode ?? null); }
  if (update.worktreePath !== undefined) { fields.push("worktree_path = ?"); values.push(update.worktreePath ?? null); }
  if (update.worktreeBranch !== undefined) { fields.push("worktree_branch = ?"); values.push(update.worktreeBranch ?? null); }
  if (update.correctionMode !== undefined) { fields.push("correction_mode = ?"); values.push(update.correctionMode ?? null); }
  if (update.deepThinkingMode !== undefined) { fields.push("deep_thinking_mode = ?"); values.push(update.deepThinkingMode ?? null); }
  if (update.preserveExecutor !== undefined) { fields.push("preserve_executor = ?"); values.push(update.preserveExecutor ?? null); }

  if (fields.length === 0) return;
  values.push(id);
  runGuarded(db, `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`, values,
    { table: "sessions", op: "update", id, from: "updateSession" });
  persistDatabase();
}

export function deleteSession(id: string): void {
  if (domainDelete(SESSION_TABLE, { id }, { scope: "session.delete", note: "会话未删除" })) return;
  const db = tryGetDatabase();
  if (!db) return;
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
  persistDatabase();
}

/** Atomically toggle the pinned state of a session */
export function togglePinned(id: string): boolean {
  const rustRow = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rustRow !== undefined) {
    if (!rustRow) return false; // 会话不存在
    const nextPinned = !rustRow.pinned;
    domainWrite(SESSION_TABLE, [sessionToWire({ ...rustRow, pinned: nextPinned })], {
      mode: "replace",
      scope: "session.togglePinned",
      note: "会话置顶状态未更新",
    });
    return nextPinned;
  }
  const db = tryGetDatabase();
  if (!db) return false;
  const result = db.exec("SELECT pinned FROM sessions WHERE id = ?", [id]);
  const current = result.length > 0 && result[0].values.length > 0 ? (result[0].values[0][0] as number) : 0;
  const newPinned = current === 1 ? 0 : 1;
  runGuarded(db, "UPDATE sessions SET pinned = ? WHERE id = ?", [newPinned, id],
    { table: "sessions", op: "pin", id, from: "setSessionPinned" });
  persistDatabase();
  return newPinned === 1;
}

export function searchSessions(query: string): Session[] {
  const rust = domainReadMany(SESSION_TABLE, wireToSession);
  if (rust) {
    const q = query.toLowerCase();
    return rust
      .filter((s) => !s.projectId.startsWith("notebook:") && s.title.toLowerCase().includes(q))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, 50);
  }
  const db = tryGetDatabase();
  if (!db) return [];
  const result = db.exec(
    "SELECT * FROM sessions WHERE title LIKE ? AND project_id NOT LIKE 'notebook:%' ORDER BY last_message_at DESC LIMIT 50",
    [`%${query}%`]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSessionFromAny);
}

/**
 * R3-2.2: Fork a session — create a child session that inherits the event log
 * of the source session. The child session has parent_id set to the source.
 *
 * This is the API-level fork (not a model tool): it creates a new session row,
 * copies the event log, and optionally copies messages for backward compat.
 *
 * @param sourceSessionId The parent session to fork from
 * @param newSessionId The new session ID for the forked child
 * @param projectId The project the child belongs to
 * @param title Optional title for the child session
 * @returns The created child Session, or null if the source doesn't exist
 */
export function forkSession(
  sourceSessionId: string,
  newSessionId: string,
  projectId: string,
  title?: string,
): Session | null {
  const source = getSession(sourceSessionId);
  if (!source) return null;

  const now = Date.now();
  const child: Session = {
    id: newSessionId,
    projectId,
    title: title || `${source.title} (fork)`,
    model: source.model,
    createdAt: now,
    lastMessageAt: now,
    messageCount: source.messageCount,
    pinned: false,
  };

  // Create the child session row with parent_id。
  // 走端口：`parent_id` 是 ALTER 加的列，整体 upsert 时显式带上（否则 fork 关系丢失）。
  if (
    domainWrite(
      SESSION_TABLE,
      [{ ...sessionToWire(child), parent_id: sourceSessionId }],
      { scope: "session.fork", note: "fork 出的会话未保存" },
    )
  ) {
    getEventLog().forkSession(sourceSessionId, newSessionId);
    return child;
  }

  const db = tryGetDatabase();
  if (!db) return null;
  db.run(
    "INSERT INTO sessions (id, project_id, title, model, created_at, last_message_at, message_count, pinned, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      child.id,
      child.projectId,
      child.title,
      child.model ?? null,
      child.createdAt,
      child.lastMessageAt,
      child.messageCount,
      0,
      sourceSessionId, // parent_id
    ],
  );
  persistDatabase();

  // Copy the event log from source to child
  getEventLog().forkSession(sourceSessionId, newSessionId);

  return child;
}

/** P2 #29: Reorder sessions by a given list of IDs (for drag-and-drop sorting) */
export function reorderSessions(projectId: string, orderedIds: string[]): void {
  // 迁移期：读出这些会话的整行 → 只改 sort_order → 整体写回。
  // 注意**只改 sort_order**（旧实现是 `UPDATE sessions SET sort_order = ? WHERE id = ? AND project_id = ?`），
  // 不要顺手把别的列一起改了。
  const rows = domainReadMany(SESSION_TABLE, wireToSession, { project_id: projectId });
  if (rows) {
    const order = new Map(orderedIds.map((sid, i) => [sid, i]));
    const targets = rows.filter((s) => order.has(s.id));
    if (targets.length > 0) {
      domainWrite(
        SESSION_TABLE,
        targets.map((s) => {
          const wire = sessionToWire(s);
          wire.sort_order = order.get(s.id);
          return wire;
        }),
        { mode: "replace", scope: "session.reorder", note: "会话顺序未保存" },
      );
    }
    return;
  }

  const db = tryGetDatabase();
  if (!db) return;
  // Update sort_order for each session
  for (let i = 0; i < orderedIds.length; i++) {
    runGuarded(db, "UPDATE sessions SET sort_order = ? WHERE id = ? AND project_id = ?", [i, orderedIds[i], projectId],
      { table: "sessions", op: "reorder", id: orderedIds[i], from: "reorderSessions" });
  }
  persistDatabase();
}
