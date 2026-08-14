/**
 * Goal Management — 目标驱动的自动续行
 *
 * Design (对标 DeepSeek Harness goal tracking):
 * - LLM 可以创建、更新、完成目标
 * - 主循环在每次迭代时检查未完成的目标
 * - 目标完成或受阻时通知 LLM
 * - 支持子目标和依赖关系
 */

import { getDatabase, persistDatabase } from "../storage/database";

// ========== Types ==========

export interface Goal {
  id: string;
  sessionId: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  priority: "low" | "normal" | "high";
  parentId?: string;
  successCriteria?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

// ========== Goal Storage ==========

export function createGoal(goal: Omit<Goal, "id" | "createdAt" | "updatedAt">): Goal {
  const db = getDatabase();
  const now = Date.now();
  const id = `goal-${now}-${Math.random().toString(36).substr(2, 6)}`;

  db.run(
    `INSERT INTO goals (id, session_id, title, description, status, priority, parent_id, success_criteria, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, goal.sessionId, goal.title, goal.description || null, goal.status, goal.priority,
     goal.parentId || null, goal.successCriteria || null, now, now],
  );
  persistDatabase();

  return { ...goal, id, createdAt: now, updatedAt: now };
}

export function getGoal(id: string): Goal | null {
  const db = getDatabase();
  const result = db.exec(
    `SELECT id, session_id, title, description, status, priority, parent_id, success_criteria, created_at, updated_at, completed_at
     FROM goals WHERE id = ?`,
    [id],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToGoal(result[0].values[0]);
}

export function listGoals(sessionId: string, status?: string): Goal[] {
  const db = getDatabase();
  const statusClause = status ? `AND status = '${status}'` : "";
  const result = db.exec(
    `SELECT id, session_id, title, description, status, priority, parent_id, success_criteria, created_at, updated_at, completed_at
     FROM goals WHERE session_id = ? ${statusClause} ORDER BY priority DESC, created_at ASC`,
    [sessionId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToGoal);
}

export function updateGoal(id: string, update: Partial<Goal>): void {
  const db = getDatabase();
  const now = Date.now();
  const fields: string[] = [];
  const values: any[] = [];

  if (update.title !== undefined) { fields.push("title = ?"); values.push(update.title); }
  if (update.description !== undefined) { fields.push("description = ?"); values.push(update.description); }
  if (update.status !== undefined) {
    fields.push("status = ?");
    values.push(update.status);
    if (update.status === "completed") { fields.push("completed_at = ?"); values.push(now); }
  }
  if (update.priority !== undefined) { fields.push("priority = ?"); values.push(update.priority); }
  if (update.successCriteria !== undefined) { fields.push("success_criteria = ?"); values.push(update.successCriteria); }

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.run(`UPDATE goals SET ${fields.join(", ")} WHERE id = ?`, values);
  persistDatabase();
}

function rowToGoal(row: any[]): Goal {
  return {
    id: row[0] as string,
    sessionId: row[1] as string,
    title: row[2] as string,
    description: row[3] as string || undefined,
    status: row[4] as Goal["status"],
    priority: row[5] as Goal["priority"],
    parentId: row[6] as string || undefined,
    successCriteria: row[7] as string || undefined,
    createdAt: row[8] as number,
    updatedAt: row[9] as number,
    completedAt: row[10] as number || undefined,
  };
}
