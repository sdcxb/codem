/**
 * Issue Storage — DB CRUD for issues + issue_comments tables
 */

import { getDatabase, persistDatabase } from "../storage/database";
import { runGuarded } from "../storage/write-guard";

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

export const IssueStorage = {
  create(issue: Omit<IssueRow, "created_at" | "updated_at">): IssueRow {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO issues (id, title, description, status, priority, assignee_type, assignee_id, project_id, squad_id, session_id, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issue.id, issue.title, issue.description ?? null, issue.status, issue.priority,
       issue.assignee_type ?? null, issue.assignee_id ?? null, issue.project_id ?? null,
       issue.squad_id ?? null, issue.session_id ?? null, issue.labels ?? null, now, now],
    );
    // 第 83 波（审计修正）：本文件原来**从不 persistDatabase()** —— 写入只留在内存里，
    // 只有"正常退出"或别处触发脏标记才会落盘 → 强杀进程就丢议题。
    persistDatabase();
    return { ...issue, created_at: now, updated_at: now };
  },
  getById(id: string): IssueRow | null {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM issues WHERE id = ?", [id]);
    if (result.length === 0) return null;
    return rowToIssue(result[0].values[0], result[0].columns);
  },

  listAll(filters?: { projectId?: string; status?: IssueStatus; squadId?: string; assigneeId?: string }): IssueRow[] {
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
    const db = getDatabase();
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(updates)) {
      const dbKey = key;
      fields.push(`${dbKey} = ?`);
      values.push(val ?? null);
    }
    if (fields.length === 0) {
      console.warn(`[IssueStorage] update(${id}) 调用时没有任何可更新字段 —— 本次没有任何写入`);
      return 0;
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
    const db = getDatabase();
    db.run("DELETE FROM issues WHERE id = ?", [id]);
    persistDatabase();
  },

  // ========== Comment CRUD ==========

  addComment(comment: Omit<IssueCommentRow, "created_at">): IssueCommentRow {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO issue_comments (id, issue_id, author_type, author_id, author_name, content, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [comment.id, comment.issue_id, comment.author_type, comment.author_id ?? null,
       comment.author_name ?? null, comment.content, comment.is_system, now],
    );
    // Update issue's updated_at
    runGuarded(db, "UPDATE issues SET updated_at = ? WHERE id = ?", [now, comment.issue_id],
    { table: "issues", op: "touch", id: comment.issue_id, from: "addIssueComment" });
    persistDatabase();
    return { ...comment, created_at: now };
  },

  getComments(issueId: string): IssueCommentRow[] {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC", [issueId]);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToComment(row, result[0].columns));
  },

  deleteComment(commentId: string): void {
    const db = getDatabase();
    db.run("DELETE FROM issue_comments WHERE id = ?", [commentId]);
    persistDatabase();
  },

  // ========== Stats ==========

  getStats(projectId?: string): Record<IssueStatus, number> {
    const db = getDatabase();
    let sql = "SELECT status, COUNT(*) as count FROM issues";
    const params: any[] = [];
    if (projectId) { sql += " WHERE project_id = ?"; params.push(projectId); }
    sql += " GROUP BY status";
    const result = db.exec(sql, params);
    const stats: Record<string, number> = {
      backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0,
    };
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
