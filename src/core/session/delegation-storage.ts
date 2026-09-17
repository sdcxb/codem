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

import type { DelegationTask, DelegationTaskRow, DelegationState } from "./types";
import { reportPersistFailure } from "../storage/persist-failure";
import {
  domainDelete,
  domainDeleteBeyond,
  domainReadMany,
  domainReadOne,
  domainWrite,
  reportWriteNotAccepted,
} from "../storage/domain-store";

// ========== 行 → 对象转换 ==========

const TABLE = "delegation_tasks";

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

/** 线协议行（列名本就是 snake_case）→ `DelegationTask` */
function wireToTask(row: Record<string, unknown>): DelegationTask {
  return {
    id: String(row.id),
    sourceSessionId: String(row.source_session_id),
    targetSessionId: String(row.target_session_id),
    task: String(row.task),
    status: row.status as DelegationState,
    result: (row.result as string) ?? undefined,
    error: (row.error as string) ?? undefined,
    projectId: String(row.project_id),
    createdAt: Number(row.created_at),
    startedAt: (row.started_at as number) ?? undefined,
    completedAt: (row.completed_at as number) ?? undefined,
  };
}

/** `DelegationTask` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function taskToWire(task: DelegationTask): Record<string, unknown> {
  return {
    id: task.id,
    source_session_id: task.sourceSessionId,
    target_session_id: task.targetSessionId,
    task: task.task,
    status: task.status,
    result: task.result ?? null,
    error: task.error ?? null,
    project_id: task.projectId,
    created_at: task.createdAt,
    started_at: task.startedAt ?? null,
    completed_at: task.completedAt ?? null,
  };
}

// ========== CRUD ==========

/** 创建委派任务 */
export function createDelegationTask(task: DelegationTask): void {
  try {
    if (domainWrite(TABLE, [taskToWire(task)], { scope: "delegation.createDelegationTask", note: "委派任务未保存" })) {
      return;
    }
    // 第 17 轮（L4）：旧库回退（INSERT delegation_tasks + persistDatabase）已删 → 如实上报。
    // 契约是 void，调用方（编排器）只能靠上报判断"任务没落库"。
    reportWriteNotAccepted("delegation.createDelegationTask", "委派任务未保存");
  } catch (e) {
    reportPersistFailure("delegation.createDelegationTask", e);
  }
}

/** 更新委派任务状态 */
export function updateDelegationTaskStatus(
  taskId: string,
  status: DelegationState,
  extra?: { result?: string; error?: string; startedAt?: number; completedAt?: number },
): void {
  try {
    const current = domainReadOne(TABLE, { id: taskId }, wireToTask);
    if (current !== undefined) {
      // 任务不存在时**什么都不写**（旧实现是 UPDATE 影响 0 行）
      if (current === null) return;
      domainWrite(
        TABLE,
        [
          taskToWire({
            ...current,
            status,
            ...(extra?.result !== undefined ? { result: extra.result } : {}),
            ...(extra?.error !== undefined ? { error: extra.error } : {}),
            ...(extra?.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
            ...(extra?.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
          }),
        ],
        { mode: "replace", scope: "delegation.updateDelegationTaskStatus", note: "委派任务状态未更新" },
      );
      return;
    }
    // 第 17 轮（L4）：旧库回退（动态拼 UPDATE + runGuarded + persistDatabase）已删 → 如实上报。
    reportWriteNotAccepted("delegation.updateDelegationTaskStatus", "委派任务状态未更新");
  } catch (e) {
    console.error("[DelegationStorage] updateDelegationTaskStatus failed:", e);
  }
}

/** 获取单个委派任务 */
export function getDelegationTask(taskId: string): DelegationTask | null {
  try {
    const rust = domainReadOne(TABLE, { id: taskId }, wireToTask);
    if (rust !== undefined) return rust;
    return null; // 第 17 轮（L4）：旧库回退已删 —— 镜像未就绪就是"查不到"
  } catch (e) {
    console.error("[DelegationStorage] getDelegationTask failed:", e);
    return null;
  }
}

/** 获取源会话的所有委派任务（作为发起方） */
export function getDelegationsBySource(sourceSessionId: string): DelegationTask[] {
  try {
    const rust = domainReadMany(TABLE, wireToTask, { source_session_id: sourceSessionId });
    if (rust) return rust.sort((a, b) => a.createdAt - b.createdAt);
    return []; // 第 17 轮（L4）：旧库回退已删 —— 诚实的空结果
  } catch (e) {
    console.error("[DelegationStorage] getDelegationsBySource failed:", e);
    return [];
  }
}

/** 获取目标会话的所有委派任务（作为接收方） */
export function getDelegationsByTarget(targetSessionId: string): DelegationTask[] {
  try {
    const rust = domainReadMany(TABLE, wireToTask, { target_session_id: targetSessionId });
    if (rust) return rust.sort((a, b) => a.createdAt - b.createdAt);
    return []; // 第 17 轮（L4）：旧库回退已删 —— 诚实的空结果
  } catch (e) {
    console.error("[DelegationStorage] getDelegationsByTarget failed:", e);
    return [];
  }
}

/** 获取项目下所有委派任务 */
export function getDelegationsByProject(projectId: string): DelegationTask[] {
  try {
    const rust = domainReadMany(TABLE, wireToTask, { project_id: projectId });
    if (rust) return rust.sort((a, b) => a.createdAt - b.createdAt);
    return []; // 第 17 轮（L4）：旧库回退已删 —— 诚实的空结果
  } catch (e) {
    console.error("[DelegationStorage] getDelegationsByProject failed:", e);
    return [];
  }
}

/** 获取所有未完成（pending/running）的委派任务 */
export function getActiveDelegations(): DelegationTask[] {
  try {
    const rust = domainReadMany(TABLE, wireToTask);
    if (rust) {
      return rust
        .filter((t) => t.status === "pending" || t.status === "running")
        .sort((a, b) => a.createdAt - b.createdAt);
    }
    return []; // 第 17 轮（L4）：旧库回退已删 —— 诚实的空结果
  } catch (e) {
    console.error("[DelegationStorage] getActiveDelegations failed:", e);
    return [];
  }
}

/**
 * 获取最近 N 条委派任务（含已完成/失败/取消）。
 * 用于重启后恢复「委派」页签的历史列表与统计——`getActiveDelegations` 只含未完成任务，
 * 只用它恢复会让历史记录与「已完成/失败」统计恒为 0。
 */
export function getRecentDelegations(limit: number = 200): DelegationTask[] {
  try {
    const rust = domainReadMany(TABLE, wireToTask);
    if (rust) {
      return rust.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, limit));
    }
    return []; // 第 17 轮（L4）：旧库回退已删 —— 诚实的空结果
  } catch (e) {
    console.error("[DelegationStorage] getRecentDelegations failed:", e);
    return [];
  }
}

/** 删除委派任务 */
export function deleteDelegationTask(taskId: string): void {
  try {
    if (domainDelete(TABLE, { id: taskId }, { scope: "delegation.deleteDelegationTask", note: "委派任务未删除" })) {
      return;
    }
    // 第 17 轮（L4）：旧库回退（DELETE + persistDatabase）已删 → 如实上报。
    reportWriteNotAccepted("delegation.deleteDelegationTask", "委派任务未删除");
  } catch (e) {
    reportPersistFailure("delegation.deleteDelegationTask", e);
  }
}

/** 清理已完成的委派任务（保留最近 N 条） */
export function clearCompletedDelegations(keepCount: number = 50): void {
  try {
    const finished = domainReadMany(TABLE, wireToTask);
    if (finished) {
      const candidates = finished.filter(
        (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
      );
      const removed = domainDeleteBeyond(
        TABLE,
        candidates.map((t) => taskToWire(t)),
        keepCount,
        { scope: "delegation.clearCompletedDelegations", note: "已完成的委派任务未清理" },
      );
      if (removed !== null) return;
    }
    // 第 17 轮（L4）：旧库回退（保留最近 N 条的 DELETE）已删 → 如实上报。
    reportWriteNotAccepted("delegation.clearCompletedDelegations", "已完成的委派任务未清理");
  } catch (e) {
    reportPersistFailure("delegation.clearCompletedDelegations", e);
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
