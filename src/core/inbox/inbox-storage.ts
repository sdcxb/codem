/**
 * Inbox Storage — DB CRUD for inbox table
 */

import { getDatabase } from "../storage/database";

// ========== Types ==========

export type InboxCategory = "issue" | "squad" | "delegation" | "automation" | "system" | "agent";
export type InboxPriority = "low" | "normal" | "high" | "urgent";

export interface InboxRow {
  id: string;
  category: string;
  title: string;
  body: string | null;
  source_type: string | null;
  source_id: string | null;
  project_id: string | null;
  squad_id: string | null;
  issue_id: string | null;
  priority: string;
  read: number;
  archived: number;
  created_at: number;
}

// ========== CRUD ==========

export const InboxStorage = {
  create(item: Omit<InboxRow, "read" | "archived" | "created_at">): InboxRow {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO inbox (id, category, title, body, source_type, source_id, project_id, squad_id, issue_id, priority, read, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [item.id, item.category, item.title, item.body ?? null, item.source_type ?? null,
       item.source_id ?? null, item.project_id ?? null, item.squad_id ?? null, item.issue_id ?? null,
       item.priority || "normal", now],
    );
    return { ...item, read: 0, archived: 0, created_at: now };
  },

  listAll(filters?: { projectId?: string; unreadOnly?: boolean; category?: InboxCategory }): InboxRow[] {
    const db = getDatabase();
    let sql = "SELECT * FROM inbox WHERE archived = 0";
    const params: any[] = [];
    if (filters?.projectId) { sql += " AND (project_id = ? OR project_id IS NULL)"; params.push(filters.projectId); }
    if (filters?.unreadOnly) { sql += " AND read = 0"; }
    if (filters?.category) { sql += " AND category = ?"; params.push(filters.category); }
    sql += " ORDER BY created_at DESC LIMIT 100";
    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToInbox(row, result[0].columns));
  },

  markRead(id: string): void {
    const db = getDatabase();
    db.run("UPDATE inbox SET read = 1 WHERE id = ?", [id]);
  },

  markAllRead(projectId?: string): void {
    const db = getDatabase();
    if (projectId) {
      db.run("UPDATE inbox SET read = 1 WHERE read = 0 AND (project_id = ? OR project_id IS NULL)", [projectId]);
    } else {
      db.run("UPDATE inbox SET read = 1 WHERE read = 0");
    }
  },

  archive(id: string): void {
    const db = getDatabase();
    db.run("UPDATE inbox SET archived = 1 WHERE id = ?", [id]);
  },

  delete(id: string): void {
    const db = getDatabase();
    db.run("DELETE FROM inbox WHERE id = ?", [id]);
  },

  getUnreadCount(projectId?: string): number {
    const db = getDatabase();
    let sql = "SELECT COUNT(*) as count FROM inbox WHERE read = 0 AND archived = 0";
    const params: any[] = [];
    if (projectId) { sql += " AND (project_id = ? OR project_id IS NULL)"; params.push(projectId); }
    const result = db.exec(sql, params);
    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  },

  deleteOlderThan(timestamp: number): void {
    const db = getDatabase();
    db.run("DELETE FROM inbox WHERE created_at < ?", [timestamp]);
  },
};

// ========== Helpers ==========

function rowToInbox(row: any[], columns: string[]): InboxRow {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj as InboxRow;
}
