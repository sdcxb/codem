/**
 * DelegationStorage — 委派任务的 DB 持久化层
 *
 * 负责委派任务的 CRUD 操作，基于 sql.js 数据库。
 * 表结构在 database.ts 的 SCHEMA 中定义（delegation_tasks 表）。
 *
 * 设计原则（参考 storage/message.ts 模式）：
 * - 所有写操作后调用 persistDatabase()（debounce 自动保存）
 * - 行 ↔ 对象转换函数私有，对外只暴露领域接口
 * - 不抛异常，失败时返回 null/空数组并 console.error
 */

import { getDatabase, persistDatabase } from "../storage/database";
import type { DelegationTask, DelegationTaskRow, DelegationState } from "./types";

// ========== 行 → 对象转换 ==========

function rowToTask(row: DelegationTaskRow): DelegationTask {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    task: row.task,
    status: row.status as DelegationState,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    projectId: row.project_id,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

// ========== CRUD ==========

/** 创建委派任务 */
export function createDelegationTask(task: DelegationTask): void {
  try {
    const db = getDatabase();
    db.run(
      `INSERT INTO delegation_tasks
        (id, source_session_id, target_session_id, task, status, result, error, project_id, created_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.sourceSessionId,
        task.targetSessionId,
        task.task,
        task.status,
        task.result ?? null,
        task.error ?? null,
        task.projectId,
        task.createdAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
      ],
    );
    persistDatabase();
  } catch (e) {
    console.error("[DelegationStorage] createDelegationTask failed:", e);
  }
}

/** 更新委派任务状态 */
export function updateDelegationTaskStatus(
  taskId: string,
  status: DelegationState,
  extra?: { result?: string; error?: string; startedAt?: number; completedAt?: number },
): void {
  try {
    const db = getDatabase();
    const sets: string[] = ["status = ?"];
    const params: any[] = [status];

    if (extra?.result !== undefined) {
      sets.push("result = ?");
      params.push(extra.result);
    }
    if (extra?.error !== undefined) {
      sets.push("error = ?");
      params.push(extra.error);
    }
    if (extra?.startedAt !== undefined) {
      sets.push("started_at = ?");
      params.push(extra.startedAt);
    }
    if (extra?.completedAt !== undefined) {
      sets.push("completed_at = ?");
      params.push(extra.completedAt);
    }

    params.push(taskId);
    db.run(`UPDATE delegation_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
    persistDatabase();
  } catch (e) {
    console.error("[DelegationStorage] updateDelegationTaskStatus failed:", e);
  }
}

/** 获取单个委派任务 */
export function getDelegationTask(taskId: string): DelegationTask | null {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM delegation_tasks WHERE id = ?", [taskId]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const v = result[0].values[0];
    return rowToTask({
      id: v[0] as string,
      source_session_id: v[1] as string,
      target_session_id: v[2] as string,
      task: v[3] as string,
      status: v[4] as string,
      result: v[5] as string | null,
      error: v[6] as string | null,
      project_id: v[7] as string,
      created_at: v[8] as number,
      started_at: v[9] as number | null,
      completed_at: v[10] as number | null,
    });
  } catch (e) {
    console.error("[DelegationStorage] getDelegationTask failed:", e);
    return null;
  }
}

/** 获取源会话的所有委派任务（作为发起方） */
export function getDelegationsBySource(sourceSessionId: string): DelegationTask[] {
  try {
    const db = getDatabase();
    const result = db.exec(
      "SELECT * FROM delegation_tasks WHERE source_session_id = ? ORDER BY created_at ASC",
      [sourceSessionId],
    );
    if (result.length === 0) return [];
    return result[0].values.map(rowToTaskFromValues);
  } catch (e) {
    console.error("[DelegationStorage] getDelegationsBySource failed:", e);
    return [];
  }
}

/** 获取目标会话的所有委派任务（作为接收方） */
export function getDelegationsByTarget(targetSessionId: string): DelegationTask[] {
  try {
    const db = getDatabase();
    const result = db.exec(
      "SELECT * FROM delegation_tasks WHERE target_session_id = ? ORDER BY created_at ASC",
      [targetSessionId],
    );
    if (result.length === 0) return [];
    return result[0].values.map(rowToTaskFromValues);
  } catch (e) {
    console.error("[DelegationStorage] getDelegationsByTarget failed:", e);
    return [];
  }
}

/** 获取项目下所有委派任务 */
export function getDelegationsByProject(projectId: string): DelegationTask[] {
  try {
    const db = getDatabase();
    const result = db.exec(
      "SELECT * FROM delegation_tasks WHERE project_id = ? ORDER BY created_at ASC",
      [projectId],
    );
    if (result.length === 0) return [];
    return result[0].values.map(rowToTaskFromValues);
  } catch (e) {
    console.error("[DelegationStorage] getDelegationsByProject failed:", e);
    return [];
  }
}

/** 获取所有未完成（pending/running）的委派任务 */
export function getActiveDelegations(): DelegationTask[] {
  try {
    const db = getDatabase();
    const result = db.exec(
      "SELECT * FROM delegation_tasks WHERE status IN ('pending', 'running') ORDER BY created_at ASC",
    );
    if (result.length === 0) return [];
    return result[0].values.map(rowToTaskFromValues);
  } catch (e) {
    console.error("[DelegationStorage] getActiveDelegations failed:", e);
    return [];
  }
}

/** 删除委派任务 */
export function deleteDelegationTask(taskId: string): void {
  try {
    const db = getDatabase();
    db.run("DELETE FROM delegation_tasks WHERE id = ?", [taskId]);
    persistDatabase();
  } catch (e) {
    console.error("[DelegationStorage] deleteDelegationTask failed:", e);
  }
}

/** 清理已完成的委派任务（保留最近 N 条） */
export function clearCompletedDelegations(keepCount: number = 50): void {
  try {
    const db = getDatabase();
    db.run(
      `DELETE FROM delegation_tasks
       WHERE status IN ('completed', 'failed', 'cancelled')
       AND id NOT IN (
         SELECT id FROM delegation_tasks
         WHERE status IN ('completed', 'failed', 'cancelled')
         ORDER BY completed_at DESC
         LIMIT ?
       )`,
      [keepCount],
    );
    persistDatabase();
  } catch (e) {
    console.error("[DelegationStorage] clearCompletedDelegations failed:", e);
  }
}

// ========== 辅助函数 ==========

function rowToTaskFromValues(v: any[]): DelegationTask {
  return rowToTask({
    id: v[0] as string,
    source_session_id: v[1] as string,
    target_session_id: v[2] as string,
    task: v[3] as string,
    status: v[4] as string,
    result: v[5] as string | null,
    error: v[6] as string | null,
    project_id: v[7] as string,
    created_at: v[8] as number,
    started_at: v[9] as number | null,
    completed_at: v[10] as number | null,
  });
}
