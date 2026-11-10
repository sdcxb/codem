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

// ========== 任务工件 / 证据 / 完成条件（C10 Artifact-centric Agents） ==========

/**
 * 任务证据的四类（C10 验收口径：代码 + 文档 + 测试 + 引用）。
 *
 * 这四类是**完成条件的最小闭包**：缺任一类都不允许进入 completed。
 * 「代码」证明产物存在，「文档」证明文档已同步，「测试」证明可验证，
 * 「引用」证明结论可回溯（issue/ADR/文件位置）。
 */
export type TaskEvidenceKind = "code" | "doc" | "test" | "reference";

/** 四类证据的固定顺序（校验与展示共用，避免两处顺序漂移） */
export const TASK_EVIDENCE_KINDS: readonly TaskEvidenceKind[] = ["code", "doc", "test", "reference"];

/**
 * 一条任务证据。
 *
 * ⚠️ 它只是**引用**，不是正文：Agent 之间共享的是工件坐标（文件/文档/测试结果/引用），
 * 不是整段聊天。`ref` 必须是可定位的坐标（路径、命令、issue 号等）。
 */
export interface TaskEvidence {
  kind: TaskEvidenceKind;
  ref: string;
  summary?: string;
  /** 仅 `test` 使用：测试必须是 pass 才算数（fail 的证据不能把任务送进 completed） */
  status?: "pass" | "fail";
  addedAt: number;
  addedBy?: string;
}

/** 登记一条证据时的输入（时间/登记人由引擎补） */
export interface TaskEvidenceInput {
  kind: TaskEvidenceKind;
  ref: string;
  summary?: string;
  status?: "pass" | "fail";
}

/**
 * 共享工件（按引用 + 版本共享）。
 *
 * `revision` 每次同一条引用被重新登记就 +1；任务领取时会快照当时的工件版本，
 * `rollbackTask` 把工件恢复到该快照 —— 这就是「回到上一版工件」。
 */
export interface TaskArtifact {
  id: string;
  kind: TaskEvidenceKind;
  ref: string;
  revision: number;
  updatedAt: number;
  updatedBy?: string;
}

/** 当前领取（谁在做）。与 `assignee` 并存：`assignee` 是归属，`claim` 是执行权。 */
interface TaskClaim {
  by: string;
  attempt: number;
  attemptId: string;
  claimedAt: number;
}

type TaskAttemptStatus =
  | "claimed"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "rolled_back";

/**
 * 一次尝试的完整记录（次数/结果）。
 *
 * `artifactSnapshot` / `evidenceSnapshot` 是**领取那一刻**的上一版状态，
 * 回滚只恢复快照，不试图理解哪一次修改是"坏"的 —— 那属于更上层的判断。
 */
export interface TaskAttemptRecord {
  attempt: number;
  attemptId: string;
  by: string;
  startedAt: number;
  endedAt?: number;
  status: TaskAttemptStatus;
  output?: string;
  artifactSnapshot: TaskArtifact[];
  evidenceSnapshot: TaskEvidence[];
}

/** 一次回滚（回到上一版工件/状态）。 */
export interface TaskRollbackRecord {
  at: number;
  by: string;
  reason: string;
  fromStatus: TeamTaskStatus;
  toStatus: TeamTaskStatus;
  attempt: number;
  restoredArtifacts: Array<{ id: string; fromRevision: number; toRevision: number }>;
}

export interface TaskVerificationCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

/**
 * Verifier 的独立检查结果。
 *
 * `evidence` 是给 Conductor/用户看的**证据坐标**，不是实现者的自评；
 * `reasons` 只在 fail 时写入。构造这个对象的 `runTaskVerification` 不读取
 * `task.output` / `attempts[].output`（实现者推理与自评），见 verifier.ts。
 */
export interface TaskVerification {
  verifier: string;
  verdict: "pass" | "fail";
  checkedAt: number;
  evidence: string[];
  reasons: string[];
  checks: TaskVerificationCheck[];
  /**
   * 本次检查实际使用的上下文快照（审计用：证明"实现者自评没有进入检查"）。
   * 只含任务图/工件/证据/文档同步结果，不含任何聊天或实现者输出。
   */
  context: TaskVerificationContext;
}

export interface TaskVerificationContext {
  taskId: string;
  subject: string;
  description?: string;
  acceptance?: string;
  dependencies: string[];
  requiredEvidence: TaskEvidenceKind[];
  implementer?: string;
  artifacts: TaskArtifact[];
  evidence: TaskEvidence[];
  docSync: DocSyncResult;
}

/** 任务完成条件（由 Conductor 建任务时声明；缺省 = 四类证据 + 独立 Verifier）。 */
interface TaskCompletionSpec {
  requiredEvidence: TaskEvidenceKind[];
  requireVerification: boolean;
}

/** 文档同步检查结果（C06 接线点）。 */
export interface DocSyncResult {
  synced: boolean;
  reason?: string;
  /** false = 本次没有可用的版本事实（无文档引用/账本里没有版本），不是"已同步" */
  checked?: boolean;
}

/**
 * 可注入的文档版本同步谓词（同步，供引擎的完成门禁使用）。
 *
 * 生产默认实现由服务层接 C06：`agent-teams/doc-sync.ts` 先异步取回
 * `documentSyncCheck` 的事实，再包成这个同步形状 —— 引擎不承担异步 IO。
 */
export type DocSyncCheck = (input: { task: TeamTask; evidence: TaskEvidence[] }) => DocSyncResult;

/** 完成门禁拦下时的结构化原因（明确 blocked，而不是静默改状态）。 */
export interface TaskCompletionBlock {
  missing: TaskEvidenceKind[];
  reasons: string[];
}

// ========== 核心实体 ==========

export interface TeamTask {
  id: string;                // 队内稳定 id：t1, t2…
  subject: string;
  description?: string;
  /** Conductor 声明的验收口径（代码/文档/测试/引用齐备；Verifier 独立检查） */
  acceptance?: string;
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

  // ===== C10：工件/尝试/回滚/证据/完成条件 =====
  /** 谁在做（执行权，与 assignee 归属分开） */
  claim?: TaskClaim;
  /** 每次领取的尝试记录（次数/结果/领取时快照） */
  attempts?: TaskAttemptRecord[];
  /** 共享工件（Agent 之间只共享这些引用与版本，不共享聊天） */
  artifacts?: TaskArtifact[];
  /** 回滚历史（回到上一版工件/状态） */
  rollbacks?: TaskRollbackRecord[];
  /** 四类证据（完成条件） */
  evidence?: TaskEvidence[];
  /** Verifier 独立检查结果（完成条件之一） */
  verification?: TaskVerification;
  /** 完成条件；缺省视为四类证据 + 独立 Verifier */
  completion?: TaskCompletionSpec;
  /** 文档同步状态（C06 检查结果；由可注入谓词或显式设置写入） */
  docSync?: DocSyncResult;
  /** 完成门禁拦下的原因（任务仍未完成） */
  blockedReason?: string;

  // ===== Bot peer（25:656 / 24:1261：TeamTask 就是 work，不另造第二套 work 模型） =====
  /**
   * peer 幂等键。**有值 = 这条任务是 Bot 间派活出来的 work**。
   *
   * 这是 24:1261「一个 Bot 身份层，架在 agent-teams 任务/邮箱之上；不另造团队系统」的
   * 落地形态：Bot 之间派活不再写第二套 `BotWork` 持久表，而是**复用**团队任务图。
   * 同一 team 内 requestId 唯一：同内容重试返回原任务，异内容拒绝（engine.createTask 校验）。
   */
  requestId?: string;
  /** handoff 树的父任务（替代旧 work.parentId；防环沿它往上走，不另建一棵树） */
  parentTaskId?: string;
  /** 发起 peer 的 Bot id（存 id 不存名字：成员改名不该改变历史归属） */
  sourceBotId?: string;
  /** 被派活的 Bot id（远端身份层坐标） */
  targetBotId?: string;
  /**
   * deadline 的**绝对时间**。到点由 `settlePeerTask` 结算成 failed（超时），
   * 不存「还剩多少毫秒」—— 重启后仍可判，也不会无限挂（25:659）。
   */
  deadlineAt?: number;
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
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
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

  // ===== Bot peer 语义（可选；缺省 = 普通团队消息，行为与旧数据一致） =====
  /**
   * `peer` = Bot 派活；`settlement` = 下游把结果/失败/超时交回上游。
   * 缺省（undefined）= 旧式普通消息，`unreadMailbox`/`acknowledgeMailbox` 一视同仁。
   */
  kind?: "peer" | "settlement";
  /** 关联的 TeamTask id：把信箱消息与任务图对上（不再有第二套 workId） */
  taskId?: string;
  /**
   * 未读合并键：同一父任务下多个子活交回时合并成**一条**未读，
   * `mergeCount` 保留「合并了几条」这个事实（不是把旧结果覆盖掉）。
   */
  mergeKey?: string;
  mergeCount?: number;
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
const AGENT_TEAMS_TOOL_IDS: ReadonlyArray<string> = [
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
