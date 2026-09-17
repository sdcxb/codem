/**
 * Issue Storage — DB CRUD for issues + issue_comments tables
 */

import { getDatabase, persistDatabase } from "../storage/database";
import { runGuarded } from "../storage/write-guard";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, shouldFallbackToLegacy, writeShouldFallBackToLegacy } from "../storage/domain-store";

// ========== Types ==========

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type IssuePriority = "low" | "normal" | "high" | "urgent";
export type AssigneeType = "user" | "agent" | "squad";

export interface IssueRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_type: string | null;
  assignee_id: string | null;
  project_id: string | null;
  squad_id: string | null;
  session_id: string | null;
  labels: string | null;
  created_at: number;
  updated_at: number;
}

export interface IssueCommentRow {
  id: string;
  issue_id: string;
  author_type: string;
  author_id: string | null;
  author_name: string | null;
  content: string;
  is_system: number;
  created_at: number;
}

// ========== Issue CRUD ==========

const ISSUES = "issues";
const COMMENTS = "issue_comments";

/** 线协议行（列名本就是 snake_case）→ `IssueRow` */
function wireToIssue(row: Record<string, unknown>): IssueRow {
  return {
    id: String(row.id),
    title: String(row.title),
    description: (row.description as string) ?? null,
    status: String(row.status),
    priority: String(row.priority ?? "normal"),
    assignee_type: (row.assignee_type as string) ?? null,
    assignee_id: (row.assignee_id as string) ?? null,
    project_id: (row.project_id as string) ?? null,
    squad_id: (row.squad_id as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    labels: (row.labels as string) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** `IssueRow` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function issueToWire(row: IssueRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    priority: row.priority ?? "normal",
    assignee_type: row.assignee_type ?? null,
    assignee_id: row.assignee_id ?? null,
    project_id: row.project_id ?? null,
    squad_id: row.squad_id ?? null,
    session_id: row.session_id ?? null,
    labels: row.labels ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function wireToComment(row: Record<string, unknown>): IssueCommentRow {
  return {
    id: String(row.id),
    issue_id: String(row.issue_id),
    author_type: String(row.author_type),
    author_id: (row.author_id as string) ?? null,
    author_name: (row.author_name as string) ?? null,
    content: String(row.content),
    is_system: Number(row.is_system ?? 0),
    created_at: Number(row.created_at),
  };
}

function commentToWire(row: IssueCommentRow): Record<string, unknown> {
  return {
    id: row.id,
    issue_id: row.issue_id,
    author_type: row.author_type,
    author_id: row.author_id ?? null,
    author_name: row.author_name ?? null,
    content: row.content,
    is_system: row.is_system,
    created_at: row.created_at,
  };
}

export const IssueStorage = {
  create(issue: Omit<IssueRow, "created_at" | "updated_at">): IssueRow {
    const now = Date.now();
    const created: IssueRow = {
      ...issue,
      description: issue.description ?? null,
      assignee_type: issue.assignee_type ?? null,
      assignee_id: issue.assignee_id ?? null,
      project_id: issue.project_id ?? null,
      squad_id: issue.squad_id ?? null,
      session_id: issue.session_id ?? null,
      labels: issue.labels ?? null,
      created_at: now,
      updated_at: now,
    };
    if (domainWrite(ISSUES, [issueToWire(created)], { scope: "issue.create", note: "议题未保存" })) {
      return created;
    }
        if (!writeShouldFallBackToLegacy("issue.create", "议题未保存")) return created;
const db = getDatabase();
    db.run(
      `INSERT INTO issues (id, title, description, status, priority, assignee_type, assignee_id, project_id, squad_id, session_id, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [created.id, created.title, created.description, created.status, created.priority,
       created.assignee_type, created.assignee_id, created.project_id,
       created.squad_id, created.session_id, created.labels, now, now],
    );
    // 第 83 波（审计修正）：本文件原来**从不 persistDatabase()** —— 写入只留在内存里，
    // 只有"正常退出"或别处触发脏标记才会落盘 → 强杀进程就丢议题。
    persistDatabase();
    return created;
  },

  getById(id: string): IssueRow | null {
    const rust = domainReadOne(ISSUES, { id }, wireToIssue);
    if (rust !== undefined) return rust;
        if (!shouldFallbackToLegacy()) return null;
const db = getDatabase();
    const result = db.exec("SELECT * FROM issues WHERE id = ?", [id]);
    if (result.length === 0) return null;
    return rowToIssue(result[0].values[0], result[0].columns);
  },

  listAll(filters?: { projectId?: string; status?: IssueStatus; squadId?: string; assigneeId?: string }): IssueRow[] {
    const rust = domainReadMany(ISSUES, wireToIssue);
    if (rust) {
      return rust
        .filter((r) => {
          if (filters?.projectId && r.project_id !== filters.projectId) return false;
          if (filters?.status && r.status !== filters.status) return false;
          if (filters?.squadId && r.squad_id !== filters.squadId) return false;
          if (filters?.assigneeId && r.assignee_id !== filters.assigneeId) return false;
          return true;
        })
        .sort((a, b) => b.updated_at - a.updated_at);
    }
        if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
    let sql = "SELECT * FROM issues WHERE 1=1";
    const params: any[] = [];
    if (filters?.projectId) { sql += " AND project_id = ?"; params.push(filters.projectId); }
    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.squadId) { sql += " AND squad_id = ?"; params.push(filters.squadId); }
    if (filters?.assigneeId) { sql += " AND assignee_id = ?"; params.push(filters.assigneeId); }
    sql += " ORDER BY updated_at DESC";
    const result = db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToIssue(row, result[0].columns));
  },

  /**
   * 更新议题字段。
   *
   * 第 84 波（A 类：静默空写）：`updates` 为空对象时原来直接 `return`（void），
   * 调用方照样会加"状态已变更"的系统评论并通知——界面上写着"已更新"，
   * 数据库里什么都没变。现在返回真正被更新的行数，并把"无字段可更新"记进日志。
   *
   * @returns 实际更新的行数（0 = 没有字段可更新，或该议题不存在）
   */
  update(id: string, updates: Partial<Pick<IssueRow, "title" | "description" | "status" | "priority" | "assignee_type" | "assignee_id" | "squad_id" | "session_id" | "labels">>): number {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      console.warn(`[IssueStorage] update(${id}) 调用时没有任何可更新字段 —— 本次没有任何写入`);
      return 0;
    }

    // 迁移期：读出整行 → 应用改动 → 整体写回。
    // 旧实现把每个 key 都写进 SET，且 `val ?? null`（显式传 undefined = 清空该列），
    // 镜像路径必须保持同样的"传入即写入"语义。
    const current = domainReadOne(ISSUES, { id }, wireToIssue);
    if (current !== undefined) {
      if (current === null) return 0; // 议题不存在：旧实现是 UPDATE 影响 0 行
      const next: IssueRow = { ...current, updated_at: Date.now() };
      for (const [key, val] of entries) {
        (next as unknown as Record<string, unknown>)[key] = val ?? null;
      }
      const written = domainWrite(ISSUES, [issueToWire(next)], {
        mode: "replace",
        scope: "issue.update",
        note: "议题未更新（议题不存在或写入失败）",
      });
      return written ? 1 : 0;
    }

        if (!writeShouldFallBackToLegacy("issue.update", "议题未更新")) return 0;
const db = getDatabase();
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of entries) {
      const dbKey = key;
      fields.push(`${dbKey} = ?`);
      values.push(val ?? null);
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    // 第 83 波：任务管理链路也走空写探测 —— 议题更新打不到行 = 界面显示的状态与库不一致
  const modified = runGuarded(db, `UPDATE issues SET ${fields.join(", ")} WHERE id = ?`, values,
    { table: "issues", op: "update", id, from: "updateIssue" });
    persistDatabase();
    return modified;
  },

  delete(id: string): void {
    if (domainDelete(ISSUES, { id }, { scope: "issue.delete", note: "议题未删除" })) return;
        if (!writeShouldFallBackToLegacy("issue.delete", "议题未删除")) return;
const db = getDatabase();
    db.run("DELETE FROM issues WHERE id = ?", [id]);
    persistDatabase();
  },

  // ========== Comment CRUD ==========

  addComment(comment: Omit<IssueCommentRow, "created_at">): IssueCommentRow {
    const now = Date.now();
    const created: IssueCommentRow = {
      ...comment,
      author_id: comment.author_id ?? null,
      author_name: comment.author_name ?? null,
      created_at: now,
    };
    if (domainWrite(COMMENTS, [commentToWire(created)], { scope: "issue.addComment", note: "议题评论未保存" })) {
      // 顺带把议题的 updated_at 顶上去（旧实现是 `UPDATE issues SET updated_at = ? WHERE id = ?`）。
      // 议题必须**确实存在**才写，否则会 upsert 出一行只有 updated_at 的幽灵议题。
      const issue = domainReadOne(ISSUES, { id: comment.issue_id }, wireToIssue);
      if (issue) {
        domainWrite(ISSUES, [issueToWire({ ...issue, updated_at: now })], {
          mode: "replace",
          scope: "issue.touch",
          note: "议题更新时间未刷新",
        });
      }
      return created;
    }
        if (!writeShouldFallBackToLegacy("issue.addComment", "议题评论未保存")) return created;
const db = getDatabase();
    db.run(
      `INSERT INTO issue_comments (id, issue_id, author_type, author_id, author_name, content, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [created.id, created.issue_id, created.author_type, created.author_id,
       created.author_name, created.content, created.is_system, now],
    );
    // Update issue's updated_at
    runGuarded(db, "UPDATE issues SET updated_at = ? WHERE id = ?", [now, comment.issue_id],
    { table: "issues", op: "touch", id: comment.issue_id, from: "addIssueComment" });
    persistDatabase();
    return created;
  },

  getComments(issueId: string): IssueCommentRow[] {
    const rust = domainReadMany(COMMENTS, wireToComment, { issue_id: issueId });
    if (rust) return rust.sort((a, b) => a.created_at - b.created_at);
        if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
    const result = db.exec("SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC", [issueId]);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToComment(row, result[0].columns));
  },

  deleteComment(commentId: string): void {
    if (domainDelete(COMMENTS, { id: commentId }, { scope: "issue.deleteComment", note: "议题评论未删除" })) return;
        if (!writeShouldFallBackToLegacy("issue.deleteComment", "议题评论未删除")) return;
const db = getDatabase();
    db.run("DELETE FROM issue_comments WHERE id = ?", [commentId]);
    persistDatabase();
  },

  // ========== Stats ==========

  getStats(projectId?: string): Record<IssueStatus, number> {
    const stats: Record<string, number> = {
      backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0,
    };
    const rust = domainReadMany(ISSUES, wireToIssue);
    if (rust) {
      for (const row of rust) {
        if (projectId && row.project_id !== projectId) continue;
        stats[row.status] = (stats[row.status] ?? 0) + 1;
      }
      return stats as Record<IssueStatus, number>;
    }
        if (!shouldFallbackToLegacy()) return {} as Record<IssueStatus, number>;
const db = getDatabase();
    let sql = "SELECT status, COUNT(*) as count FROM issues";
    const params: any[] = [];
    if (projectId) { sql += " WHERE project_id = ?"; params.push(projectId); }
    sql += " GROUP BY status";
    const result = db.exec(sql, params);
    if (result.length > 0) {
      for (const row of result[0].values) {
        stats[row[0] as string] = row[1] as number;
      }
    }
    return stats as Record<IssueStatus, number>;
  },
};

// ========== Helpers ==========

function rowToIssue(row: any[], columns: string[]): IssueRow {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj as IssueRow;
}

function rowToComment(row: any[], columns: string[]): IssueCommentRow {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj as IssueCommentRow;
}
