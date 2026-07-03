import { getDatabase, persistDatabase } from "./database";
import type { Session } from "../llm/session";

export function loadV2Sessions(): Map<string, Session> {
  const sessions = new Map<string, Session>();
  try {
    const db = getDatabase();
    const result = db.exec("SELECT id, project_id, title, model, messages, total_usage, created_at, updated_at FROM v2_sessions");
    if (result.length > 0) {
      for (const row of result[0].values) {
        const session: Session = {
          id: row[0] as string,
          projectId: row[1] as string,
          title: row[2] as string,
          model: row[3] as string || "",
          messages: JSON.parse((row[4] as string) || "[]"),
          totalUsage: JSON.parse((row[5] as string) || '{"promptTokens":0,"completionTokens":0,"cost":0}'),
          createdAt: row[6] as number,
          updatedAt: row[7] as number,
        };
        sessions.set(session.id, session);
      }
    }
  } catch (e) {
    // Database not initialized yet, return empty map
    console.warn("[V2Session] Database not ready, returning empty sessions");
  }
  return sessions;
}

export function saveV2Session(session: Session): void {
  const db = getDatabase();
  try {
    const existing = db.exec("SELECT id FROM v2_sessions WHERE id = ?", [session.id]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      db.run(
        "UPDATE v2_sessions SET project_id = ?, title = ?, model = ?, messages = ?, total_usage = ?, updated_at = ? WHERE id = ?",
        [session.projectId, session.title, session.model, JSON.stringify(session.messages), JSON.stringify(session.totalUsage), session.updatedAt, session.id]
      );
    } else {
      db.run(
        "INSERT INTO v2_sessions (id, project_id, title, model, messages, total_usage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [session.id, session.projectId, session.title, session.model, JSON.stringify(session.messages), JSON.stringify(session.totalUsage), session.createdAt, session.updatedAt]
      );
    }
    persistDatabase();
  } catch (e) {
    console.warn("[V2Session] Failed to save session:", e);
  }
}

export function deleteV2Session(id: string): void {
  const db = getDatabase();
  try {
    db.run("DELETE FROM v2_sessions WHERE id = ?", [id]);
    persistDatabase();
  } catch (e) {
    console.warn("[V2Session] Failed to delete session:", e);
  }
}
