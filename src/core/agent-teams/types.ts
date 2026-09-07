/**
 * @codem/agent-teams — 多智能体团队编排（B3，对标 EAC dsh-agent-teams / Claude Code AgentTeams）
 *
 * 核心概念（与 EAC 架构报告 .eac-analysis/agent-teams-report.md 对齐）：
 * - 队长 Captain：创建团队的调用方 agent 会话；建队/拆任务/派发/转派/汇总。
 * - 成员 Member：队长 spawn 的可续聊子 agent（Codem SubagentRuntime.startContinuable），
 *   成员名 = 持久化子会话 id；共享 agent_teams_* 工具但 deny 队长专属工具。
 * - 任务 Task：有负责人 + 显式 dependencies 的状态机条目；依赖未全部 completed 不可领取。
 * - attempt / attemptId：执行代次 + 能力令牌；成员 update 必须携带一致 attemptId，
 *   转派/接管即作废旧代 → 迟到结果拒绝（stale）。
 * - 邮箱 Mailbox：每 agent 一条消息队列；成员直达消息的持久化通道。
 */

// ========== 任务状态机 ==========

export type TeamTaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed" | "cancelled";

/** 终态集合（不可再迁移） */
export const TASK_TERMINAL: ReadonlySet<TeamTaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** 允许的迁移表 */
export const TASK_TRANSITIONS: Record<TeamTaskStatus, TeamTaskStatus[]> = {
  pending: ["claimed", "cancelled", "failed"],
  claimed: ["in_progress", "pending", "failed", "cancelled"], // pending = 领取回滚/转派回池
  in_progress: ["completed", "failed", "cancelled", "pending"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  if (from === to) return true; // 幂等（同态允许，仅更新 output 等）
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

// ========== 核心实体 ==========

export interface TeamTask {
  id: string;                // 队内稳定 id：t1, t2…
  subject: string;
  description?: string;
  status: TeamTaskStatus;
  assignee?: string;         // 成员名或 "captain"；undefined = 未指派（共享池）
  dependencies: string[];    // 前置任务 id，须全部 completed
  output?: string;
  attempt: number;           // 单调执行代次
  attemptId?: string;        // 当前 claimed/in_progress 尝试的能力令牌（UUID）
  handoffId?: string;        // 撤销/交接尚未开新 attempt 时的 opaque 代次
  reassigning?: boolean;     // 交接静默期：调度器不得分发
  createdAt: number;
  updatedAt: number;
}

export type MemberStatus = "idle" | "working" | "removed" | "absent";

export interface TeamMember {
  id: string;                // 持久化子会话 id（SubagentRuntime child id）
  name: string;              // 展示名（队内唯一）
  role?: string;
  status: MemberStatus;
  /** LLM 路由快照：显式指定时使用；缺省 = 继承队长当前路由 */
  provider?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  addedAt: number;
}

export interface MailboxMessage {
  id: string;
  to: string;                // "captain" 或成员名
  from: string;
  content: string;
  deliveredAt?: number;      // 直投成功时间戳（= 已 ack）
  claimedAt?: number;        // 交付租赁时间戳（60s 过期可重投）
  createdAt: number;
}

export interface AgentTeam {
  id: string;
  name: string;
  captainSessionId: string;  // 队长（创建者）会话
  members: TeamMember[];
  tasks: TeamTask[];
  mailbox: MailboxMessage[];
  taskSeq: number;           // t{n} 序号
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

// ========== 工具面常量 ==========

/** 队长专属工具（成员被 deny） */
export const CAPTAIN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "agent_teams_create",
  "agent_teams_add_member",
  "agent_teams_remove_member",
  "agent_teams_create_task",
  "agent_teams_reassign_task",
  "agent_teams_delete",
]);

/** 全部 agent_teams 工具（用于工具表注入提示） */
export const AGENT_TEAMS_TOOL_IDS: ReadonlyArray<string> = [
  "agent_teams_create",
  "agent_teams_add_member",
  "agent_teams_remove_member",
  "agent_teams_create_task",
  "agent_teams_reassign_task",
  "agent_teams_claim_task",
  "agent_teams_update_task",
  "agent_teams_send_message",
  "agent_teams_status",
  "agent_teams_delete",
];

/** 队长保留名 */
export const CAPTAIN = "captain";

/** 邮箱交付租赁时长（ms）：60s 后未确认可被重投 */
export const MAILBOX_LEASE_MS = 60_000;
