/**
 * Inbox Storage — DB CRUD for inbox table
 */

import { getDatabase, persistDatabase } from "../storage/database";
import { runGuarded } from "../storage/write-guard";
import {
  domainDelete,
  domainDeleteWhere,
  domainReadMany,
  domainReadOne,
  domainWrite,
} from "../storage/domain-store";

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

const TABLE = "inbox";
/** 通知保留期：只增不减会让数据库持续膨胀（自动化触发器每次触发都插一行） */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 线协议行就是 snake_case，直接用（字段显式列出，避免多余列混进返回值） */
function wireToInbox(row: Record<string, unknown>): InboxRow {
  return {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    body: (row.body as string) ?? null,
    source_type: (row.source_type as string) ?? null,
    source_id: (row.source_id as string) ?? null,
    project_id: (row.project_id as string) ?? null,
    squad_id: (row.squad_id as string) ?? null,
    issue_id: (row.issue_id as string) ?? null,
    priority: String(row.priority ?? "normal"),
    read: Number(row.read ?? 0),
    archived: Number(row.archived ?? 0),
    created_at: Number(row.created_at),
  };
}

/** `InboxRow` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function inboxToWire(row: InboxRow): Record<string, unknown> {
  return { ...row };
}

export const InboxStorage = {
  create(item: Omit<InboxRow, "read" | "archived" | "created_at">): InboxRow {
    const now = Date.now();
    const created: InboxRow = {
      ...item,
      body: item.body ?? null,
      source_type: item.source_type ?? null,
      source_id: item.source_id ?? null,
      project_id: item.project_id ?? null,
      squad_id: item.squad_id ?? null,
      issue_id: item.issue_id ?? null,
      priority: item.priority || "normal",
      read: 0,
      archived: 0,
      created_at: now,
    };

    if (domainWrite(TABLE, [inboxToWire(created)], { scope: "inbox.create", note: "通知未保存" })) {
      // 顺带清掉过期通知。**必须走域端口**：镜像已接手时若只删旧库，
      // 下一次整行写回会把旧库里"其实早已被清掉"的行重新插回 Rust（复活已删除数据）。
      const removed = domainDeleteWhere(
        TABLE,
        (row) => Number(row.created_at) < now - RETENTION_MS,
        "id",
        { scope: "inbox.sweep", note: "过期通知未清理" },
      );
      if (removed !== null) return created;
    }

    const db = getDatabase();
    if (!db) return created;
    db.run(
      `INSERT INTO inbox (id, category, title, body, source_type, source_id, project_id, squad_id, issue_id, priority, read, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [created.id, created.category, created.title, created.body, created.source_type,
       created.source_id, created.project_id, created.squad_id, created.issue_id,
       created.priority, now],
    );
    persistDatabase();
    try {
      db.run("DELETE FROM inbox WHERE created_at < ?", [now - RETENTION_MS]);
      persistDatabase();
    } catch {
      /* 清理失败不影响写入 */
    }
    return created;
  },

  listAll(filters?: { projectId?: string; unreadOnly?: boolean; category?: InboxCategory }): InboxRow[] {
    const rust = domainReadMany(TABLE, wireToInbox, { archived: 0 });
    if (rust) {
      const filtered = rust.filter((r) => {
        if (filters?.projectId && r.project_id !== filters.projectId && r.project_id !== null) return false;
        if (filters?.unreadOnly && r.read !== 0) return false;
        if (filters?.category && r.category !== filters.category) return false;
        return true;
      });
      // 与旧 SQL 一致：created_at DESC + LIMIT 100
      return filtered.sort((a, b) => b.created_at - a.created_at).slice(0, 100);
    }
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
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current !== undefined) {
      // 行不存在时用 `current === null` 判断，**不要**写成 `!current`：
      // 那是"假值"判断，行不存在与"字段为空"会被混为一谈（这里踩过一次）。
      if (current === null || current.read === 1) return;
      domainWrite(TABLE, [inboxToWire({ ...current, read: 1 })], {
        mode: "replace",
        scope: "inbox.markRead",
        note: "通知未标记为已读",
      });
      return;
    }
    const db = getDatabase();
    runGuarded(db, "UPDATE inbox SET read = 1 WHERE id = ?", [id],
    { table: "inbox", op: "mark-read", id, from: "markInboxRead" });
  },

  markAllRead(projectId?: string): void {
    const rust = domainReadMany(TABLE, wireToInbox, { read: 0 });
    if (rust) {
      const targets = rust.filter(
        (row) => !projectId || row.project_id === projectId || row.project_id === null,
      );
      if (targets.length === 0) return;
      domainWrite(TABLE, targets.map((row) => inboxToWire({ ...row, read: 1 })), {
        mode: "replace",
        scope: "inbox.markAllRead",
        note: "通知未批量标记为已读",
      });
      return;
    }
    const db = getDatabase();
    if (projectId) {
      db.run("UPDATE inbox SET read = 1 WHERE read = 0 AND (project_id = ? OR project_id IS NULL)", [projectId]);
    persistDatabase();
    } else {
      db.run("UPDATE inbox SET read = 1 WHERE read = 0");
    persistDatabase();
    }
  },

  archive(id: string): void {
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current !== undefined) {
      if (current === null || current.archived === 1) return;
      domainWrite(TABLE, [inboxToWire({ ...current, archived: 1 })], {
        mode: "replace",
        scope: "inbox.archive",
        note: "通知未归档",
      });
      return;
    }
    const db = getDatabase();
    runGuarded(db, "UPDATE inbox SET archived = 1 WHERE id = ?", [id],
    { table: "inbox", op: "archive", id, from: "archiveInbox" });
  },

  delete(id: string): void {
    if (domainDelete(TABLE, { id }, { scope: "inbox.delete", note: "通知未删除" })) return;
    const db = getDatabase();
    if (!db) return;
    db.run("DELETE FROM inbox WHERE id = ?", [id]);
    persistDatabase();
  },

  getUnreadCount(projectId?: string): number {
    const rust = domainReadMany(TABLE, wireToInbox, { read: 0, archived: 0 });
    if (rust) {
      return rust.filter(
        (r) => !projectId || r.project_id === projectId || r.project_id === null,
      ).length;
    }
    const db = getDatabase();
    let sql = "SELECT COUNT(*) as count FROM inbox WHERE read = 0 AND archived = 0";
    const params: any[] = [];
    if (projectId) { sql += " AND (project_id = ? OR project_id IS NULL)"; params.push(projectId); }
    const result = db.exec(sql, params);
    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  },

  deleteOlderThan(timestamp: number): void {
    const removed = domainDeleteWhere(
      TABLE,
      (row) => Number(row.created_at) < timestamp,
      "id",
      { scope: "inbox.deleteOlderThan", note: "过期通知未删除" },
    );
    if (removed !== null) return;
    const db = getDatabase();
    if (!db) return;
    db.run("DELETE FROM inbox WHERE created_at < ?", [timestamp]);
    persistDatabase();
  },
};

// ========== Helpers ==========

function rowToInbox(row: any[], columns: string[]): InboxRow {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj as InboxRow;
}