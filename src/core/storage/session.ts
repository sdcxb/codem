import { getDatabase, persistDatabase } from "./database";
import type { Session } from "../types";

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  model: string | null;
  created_at: number;
  last_message_at: number;
  message_count: number;
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
  });
}

export function listSessions(projectId: string): Session[] {
  const db = getDatabase();
  const result = db.exec(
    "SELECT * FROM sessions WHERE project_id = ? ORDER BY last_message_at DESC",
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
    "INSERT INTO sessions (id, project_id, title, model, created_at, last_message_at, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      session.id,
      session.projectId,
      session.title,
      session.model ?? null,
      session.createdAt,
      session.lastMessageAt,
      session.messageCount,
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

export function searchSessions(query: string): Session[] {
  const db = getDatabase();
  const result = db.exec(
    "SELECT * FROM sessions WHERE title LIKE ? ORDER BY last_message_at DESC LIMIT 50",
    [`%${query}%`]
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSessionFromAny);
}
