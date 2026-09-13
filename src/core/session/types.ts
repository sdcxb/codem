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
   * 第 64 波（用户质疑「用时间做可靠性」之后重做）：等待**不再按固定时钟返回**，
   * 而是按**子会话的活动**返回 —— 满足任一条件就返回：
   *   · 任务结束（完成/失败/取消）；
   *   · 子会话**连续 `waitIdleMs` 没有上报任何进度**（= 它安静了，而不是"它跑了很久"）。
   *
   * 这样合法的长任务（一直在产出）可以被一直等下去，而卡住的会话会很快"安静"下来被识别。
   * 原来的「单次 3 分钟 / 累计 8 分钟」是拍出来的钟表阈值，已删除。
   */
  waitIdleMs: number;
  /**
   * 第 64 波：后台/委派会话的**空闲**上限（ms）—— 时间只用来测"沉默"，不用来测"总共跑了多久"。
   *
   * 语义对齐 DSH 的 `idleWatchdog`：后台会话每收到一个事件就重新上弦，只有连续这么久
   * **一个事件都没有**才中止。`<= 0` 表示不设空闲上限。
   */
  turnIdleMs: number;
  /**
   * 第 64 波：后台/委派会话单轮的**资源**预算（估算 token，0 = 不限）。
   *
   * 上限用**资源**而不是时钟：合法的大任务可以随便跑多久，但花钱要有数
   * （DSH 同样把 `maxTokens` 这类上限放在 settings schema 里，而不是散落的魔法数字）。
   */
  turnTokenBudget: number;
}

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  maxDepth: 2,
  maxConcurrent: 5,
  defaultTimeout: 0, // 任务本身不设超时，依赖 abort 信号取消
  waitIdleMs: 3 * 60 * 1000, // 子会话连续 3 分钟没有进度上报 → 判定"安静了"，带进度返回
  turnIdleMs: 5 * 60 * 1000, // 后台会话连续 5 分钟没有任何事件 → 判定空闲（对齐 DSH 的流空闲默认值）
  turnTokenBudget: 0, // 资源预算：0 = 不限（用资源设上限，不用时钟）
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
