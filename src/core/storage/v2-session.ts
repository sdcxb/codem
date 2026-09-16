import { getDatabase, persistDatabase } from "./database";
import type { Session } from "../llm/session";
import { domainDelete, domainReadMany, domainWrite } from "./domain-store";

// ========== 迁移期分流（P3 第 12 段） ==========
//
// `v2_sessions` 是"整会话一把存"的形态：`messages` / `total_usage` 两列存的是 JSON 文本。
// 因此这里必须**逐行转换**（对象 ←→ JSON 字符串），不能像普通列那样直传。

const TABLE = "v2_sessions";

/** 线协议行 → Session（JSON 列需要解析） */
function wireToSession(row: Record<string, unknown>): Session {
  const parse = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    title: String(row.title ?? ""),
    model: String(row.model ?? ""),
    messages: parse(row.messages, [] as unknown[]),
    totalUsage: parse(row.total_usage, { promptTokens: 0, completionTokens: 0, cost: 0 }),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  } as Session;
}

/** Session → 线协议行（JSON 列序列化） */
function sessionToWire(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    project_id: session.projectId,
    title: session.title,
    model: session.model ?? "",
    messages: JSON.stringify(session.messages ?? []),
    total_usage: JSON.stringify(session.totalUsage ?? { promptTokens: 0, completionTokens: 0, cost: 0 }),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function loadV2Sessions(): Map<string, Session> {
  const rust = domainReadMany(TABLE, wireToSession);
  if (rust) {
    const sessions = new Map<string, Session>();
    for (const s of rust) sessions.set(s.id, s);
    return sessions;
  }
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
  if (domainWrite(TABLE, [sessionToWire(session)], { mode: "replace", scope: "v2Session.save", note: "会话未保存" })) {
    return;
  }
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
  if (domainDelete(TABLE, { id }, { scope: "v2Session.delete", note: "会话未删除" })) return;
  const db = getDatabase();
  try {
    db.run("DELETE FROM v2_sessions WHERE id = ?", [id]);
    persistDatabase();
  } catch (e) {
    console.warn("[V2Session] Failed to delete session:", e);
  }
}
