import { getDatabase, persistDatabase } from "./database";
import { getEventLog } from "./event-log";
import type { Session } from "../types";

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
  const db = getDatabase();
  const result = db.exec(
    "SELECT * FROM sessions WHERE project_id = ? ORDER BY pinned DESC, last_message_at DESC",
    [projectId]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSessionFromAny);
}

export function getSession(id: string): Session | null {
  const db = getDatabase();
  const result = db.exec("SELECT * FROM sessions WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToSessionFromAny(result[0].values[0]);
}

export function createSession(session: Session): void {
  const db = getDatabase();
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
  const db = getDatabase();
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
  db.run(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
  persistDatabase();
}

/** Atomically toggle the pinned state of a session */
export function togglePinned(id: string): boolean {
  const db = getDatabase();
  const result = db.exec("SELECT pinned FROM sessions WHERE id = ?", [id]);
  const current = result.length > 0 && result[0].values.length > 0 ? (result[0].values[0][0] as number) : 0;
  const newPinned = current === 1 ? 0 : 1;
  db.run("UPDATE sessions SET pinned = ? WHERE id = ?", [newPinned, id]);
  persistDatabase();
  return newPinned === 1;
}

export function searchSessions(query: string): Session[] {
  const db = getDatabase();
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

  // Create the child session row with parent_id
  const db = getDatabase();
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
  const db = getDatabase();
  // Update sort_order for each session
  for (let i = 0; i < orderedIds.length; i++) {
    db.run("UPDATE sessions SET sort_order = ? WHERE id = ? AND project_id = ?", [i, orderedIds[i], projectId]);
  }
  persistDatabase();
}
