/**
 * 跨会话 Agent 协作 — 类型定义
 *
 * 方案3 核心类型：委派任务、会话间消息、编排状态。
 * 所有类型集中在此文件，供 bus / orchestrator / storage / tools 共享。
 */

// ========== 委派任务状态 ==========

export type DelegationState = "pending" | "running" | "completed" | "failed" | "cancelled";

// ========== 会话间消息 ==========

export type SessionMessageType =
  | "delegation" // 委派请求：源 → 目标
  | "result" // 委派结果：目标 → 源
  | "status" // 状态更新（permission_required / busy / idle）
  | "cancel"; // 取消委派

export interface SessionMessage {
  id: string;
  type: SessionMessageType;
  sourceSessionId: string;
  targetSessionId: string;
  /** 委派的任务描述（delegation 类型时必填） */
  task?: string;
  /** 回传的结果文本（result 类型时必填） */
  result?: string;
  /** 状态详情（status 类型时使用） */
  detail?: string;
  /** 关联的 delegationTaskId */
  taskId?: string;
  timestamp: number;
}

// ========== 委派任务 ==========

export interface DelegationTask {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  /** 委派给目标会话的任务描述 */
  task: string;
  status: DelegationState;
  /** 目标会话完成后回传的结果 */
  result?: string;
  /** 失败时的错误信息 */
  error?: string;
  /** 当前所属项目 ID（用于隔离不同项目的委派） */
  projectId: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Squad ID if this delegation is part of a squad (optional, for squad routing) */
  squadId?: string;
  /** Member ID if this delegation targets a specific squad member */
  memberId?: string;
}

// ========== 编排器配置 ==========

export interface DelegationConfig {
  /** 最大委派深度（A→B→C 为深度 2） */
  maxDepth: number;
  /** 最大并发委派任务数 */
  maxConcurrent: number;
  /** 委派任务超时（ms），0 = 不超时 */
  defaultTimeout: number;
}

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  maxDepth: 2,
  maxConcurrent: 5,
  defaultTimeout: 0, // 不超时，依赖 abort 信号取消
};

// ========== DB 行类型 ==========

export interface DelegationTaskRow {
  id: string;
  source_session_id: string;
  target_session_id: string;
  task: string;
  status: string;
  result: string | null;
  error: string | null;
  project_id: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}
