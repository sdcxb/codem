/**
 * Goal Management — 目标驱动的自动续行
 *
 * Design (对标 DeepSeek Harness goal tracking):
 * - LLM 可以创建、更新、完成目标
 * - 主循环在每次迭代时检查未完成的目标
 * - 目标完成或受阻时通知 LLM
 * - 支持子目标和依赖关系
 */

import { reportPersistFailure } from "../storage/persist-failure";
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

  /**
   * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，返回内存里那份已构造好的对象。
   *
   * 返回 `created` 与旧实现在 A 态下的行为**完全一致**（旧实现无论 SQL 是否成功都返回它），
   * 所以这里不是新造的"假成功"—— 差别只是失败现在**可见**（原来静默落库，
   * 现在是一条 persist 失败记录），也不会再出现"写进旧库、读路径却只认端口"的读写分裂。
   */
  reportPersistFailure(
    "goal.create",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "目标未保存",
  );
  return created;
}

export function getGoal(id: string): Goal | null {
  const rust = domainReadOne(TABLE, { id }, wireToGoal);
  if (rust !== undefined) return rust;
  // 端口没接手 → 该域读不到这一行（旧库已从渲染进程移除）→ 如实返回 null
  return null;
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
  /**
   * **旧库读取已删除**（L4 收尾）：端口没接手 → 该域的合理空结果（空数组）。
   * 与原来门控里那句 `if (!shouldFallbackToLegacy()) return [];` **语义一致**。
   */
  return [];
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

  /**
   * **旧库更新已删除**（L4 收尾）：端口没接手时**如实上报为"未更新"**。
   *
   * ⚠️ 这里**不能**静默 return：`updateGoal` 的契约是 void，调用方（进度面板 / 主循环）
   * 只能靠"有没有失败上报"来判断这次改动有没有落地 —— 静默就是 B 类假成功。
   */
  reportPersistFailure(
    "goal.update",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "目标未更新",
  );
}
