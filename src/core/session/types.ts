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
  /**
   * 第 62 波：子会话执行进度。
   *
   * 事故背景：父会话 `wait_for_delegation` 会**无限期阻塞**，而子会话在原地打转（反复枚举同一目录），
   * 于是父会话十几分钟里既没有产出、也不知道子会话在干什么。现在子会话定期上报进度，
   * 等待超时后父会话能拿到「已跑多久 / 调了多少次工具 / 最新输出」并自行决定继续等还是先干别的。
   */
  progress?: DelegationProgress;
  /** 已累计等待时长（ms）—— 父会话反复"再等一轮"时用它兜住总时长 */
  waitedMs?: number;
}

export interface DelegationProgress {
  /** 已完成的工具调用次数 */
  toolCalls: number;
  /** 子会话最新的文本片段（截断，用于判断它在干什么） */
  lastText: string;
  updatedAt: number;
  /** 最近一次工具调用描述（第 62 波加：一眼看出是不是在重复同一件事） */
  lastTool?: string;
}

// ========== 编排器配置 ==========

export interface DelegationConfig {
  /** 最大委派深度（A→B→C 为深度 2） */
  maxDepth: number;
  /** 最大并发委派任务数 */
  maxConcurrent: number;
  /** 委派任务超时（ms），0 = 不超时 */
  defaultTimeout: number;
  /**
   * 第 62 波：`wait_for_delegation` 单次等待的预算（ms）。
   *
   * 语义是「**这一等最多等多久**」，不是「任务多久必须完成」：到点后等待会带着
   * 当前进度返回，父会话可以选择继续等（再调一次）或先做别的事。
   * 之所以必须加：不加就等于父会话把控制权无限期交出去，子会话打转时用户看到的是"卡住"。
   */
  waitTimeoutMs: number;
  /**
   * 第 62 波（审计补）：同一任务**累计**等待预算（ms）。
   *
   * 只有单次预算是不够的 —— 「等一轮 → 再等一轮」可以无限循环，父会话照样黑等半小时。
   * 累计预算用完之后，后续等待**立即返回进度**（只查看、不阻塞），直到任务真正结束。
   */
  waitBudgetMs: number;
  /**
   * 第 62 波：后台/委派会话单轮执行的**墙钟上限**（ms）。
   * 到点强制中止并回传部分产出 —— 兜住"子会话原地打转把父会话拖死"这一类。
   */
  maxTurnMs: number;
}

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  maxDepth: 2,
  maxConcurrent: 5,
  defaultTimeout: 0, // 任务本身不设超时，依赖 abort 信号取消
  waitTimeoutMs: 3 * 60 * 1000, // 单次等待 3 分钟（到点带进度返回，可再次等待）
  waitBudgetMs: 8 * 60 * 1000, // 同一任务累计等待 8 分钟（之后只查看进度，不再阻塞）
  maxTurnMs: 15 * 60 * 1000, // 后台单轮 15 分钟墙钟上限（正常任务远低于此）
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
