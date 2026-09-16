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
import { runGuarded } from "../storage/write-guard";
import { domainReadMany, domainReadOne, domainWrite } from "../storage/domain-store";

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

const TABLE = "goals";

/**
 * 线协议行（snake_case）→ `Goal`。
 *
 * 旧实现用 `db.exec` 拿到的是**位置数组**，新增列会整体错位；
 * 镜像给的是**具名列**，所以这里单独写一个转换函数，
 * 并显式列出每一列，避免"某天加一列就静默读空"。
 */
function wireToGoal(row: Record<string, unknown>): Goal {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    title: String(row.title),
    description: (row.description as string) || undefined,
    status: row.status as Goal["status"],
    priority: row.priority as Goal["priority"],
    parentId: (row.parent_id as string) || undefined,
    successCriteria: (row.success_criteria as string) || undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    completedAt: (row.completed_at as number) || undefined,
  };
}

/** `Goal` → 线协议行（显式列全字段：整体 upsert 时缺列会被写成 NULL） */
function goalToWire(goal: Goal): Record<string, unknown> {
  return {
    id: goal.id,
    session_id: goal.sessionId,
    title: goal.title,
    description: goal.description ?? null,
    status: goal.status,
    priority: goal.priority,
    parent_id: goal.parentId ?? null,
    success_criteria: goal.successCriteria ?? null,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
    completed_at: goal.completedAt ?? null,
  };
}

export function createGoal(goal: Omit<Goal, "id" | "createdAt" | "updatedAt">): Goal {
  const now = Date.now();
  const id = `goal-${now}-${Math.random().toString(36).substr(2, 6)}`;
  const created: Goal = { ...goal, id, createdAt: now, updatedAt: now };

  if (domainWrite(TABLE, [goalToWire(created)], { scope: "goal.create", note: "目标未保存" })) {
    return created;
  }

  const db = getDatabase();
  db.run(
    `INSERT INTO goals (id, session_id, title, description, status, priority, parent_id, success_criteria, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, goal.sessionId, goal.title, goal.description || null, goal.status, goal.priority,
     goal.parentId || null, goal.successCriteria || null, now, now],
  );
  persistDatabase();

  return created;
}

export function getGoal(id: string): Goal | null {
  const rust = domainReadOne(TABLE, { id }, wireToGoal);
  if (rust !== undefined) return rust;
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
  const where: Record<string, unknown> = status
    ? { session_id: sessionId, status }
    : { session_id: sessionId };
  const rust = domainReadMany(TABLE, wireToGoal, where);
  if (rust) {
    // 排序必须与旧实现的 `ORDER BY priority DESC, created_at ASC` 一致。
    // 注意这里是 **SQLite 的 TEXT 默认排序规则（BINARY：按字节序）**：
    // "low" < "normal" < "high"，所以 `DESC` 的实际结果是
    // normal → low → high，而不是"高优先级在前"的语义序。
    // 不能用 localeCompare 代替（它会给出 high → normal → low），
    // 那属于顺手改掉既有列表顺序，不是这次迁移该做的事。
    return rust.sort((a, b) => {
      const pa = String(a.priority ?? "");
      const pb = String(b.priority ?? "");
      if (pa !== pb) return pb < pa ? -1 : 1;
      return Number(a.createdAt) - Number(b.createdAt);
    });
  }
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
  const now = Date.now();

  // 迁移期：从镜像读出整行 → 应用改动 → 整体写回。
  // 镜像未接手（未加载完）时不路由，继续走旧库，避免"写进 Rust、读到的还是旧值"。
  const current = domainReadOne(TABLE, { id }, wireToGoal);
  if (current !== undefined) {
    if (current === null) return; // 目标不存在：与旧实现（UPDATE 影响 0 行）一致
    const next: Goal = {
      ...current,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.priority !== undefined ? { priority: update.priority } : {}),
      ...(update.successCriteria !== undefined ? { successCriteria: update.successCriteria } : {}),
      ...(update.status === "completed" ? { completedAt: now } : {}),
      updatedAt: now,
    };
    domainWrite(TABLE, [goalToWire(next)], {
      mode: "replace",
      scope: "goal.update",
      note: "目标未更新（目标不存在或写入失败）",
    });
    return;
  }

  const db = getDatabase();
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

  runGuarded(db, `UPDATE goals SET ${fields.join(", ")} WHERE id = ?`, values,
    { table: "goals", op: "update", id, from: "updateGoal" });
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
