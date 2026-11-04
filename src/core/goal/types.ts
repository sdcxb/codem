/**
 * 长程目标模式（Long-horizon Goal Mode）—— 类型与不变量。
 *
 * ## 设计依据
 *
 * `docs/architecture/GOAL-MODE-PLAN.md` + `docs/architecture/ADR-0006-LONG-HORIZON-GOAL.md`。
 * 一句话：**目标是一次契约，计划是一次深规划的里程碑 DAG，执行按阶段证据验收，
 * 重规划是带证据的版本事件。**
 *
 * ## 与旧 `goal.ts` 的区别（不要混用）
 *
 * `src/core/goal/goal.ts` 是历史目标记录（`goals` 表 + create_goal 工具）：title/description 粒度、
 * 每轮可改 —— 正是本模式要取代的「短步目标」。本文件的契约/计划/阶段/证据/决策是**另一套形状**，
 * 落在 `goal_contracts` / `goal_plans` / `goal_phases` / `goal_evidence` / `goal_decisions` 五张表，
 * 语义与不可变性完全不同，**不复用旧表**（复用会把两套不变量揉成一套，谁都不成立）。
 *
 * ## 不可变性（本文件定义的硬规则）
 *
 * | 字段 | 可否变 | 谁可以改 |
 * |---|---|---|
 * | `statement / principles / nonGoals / constraints / acceptance` | **不可变** | 只有用户在确认后改意图（`changeContract(..., {confirmedByUser:true})`） |
 * | `phases[].outcome / acceptance / dependsOn` | 计划版本内不可变 | 重规划生成**新版本**（已完成阶段原样保留） |
 * | `phases[].status / attempts` | 可变 | Goal Runner（唯一写入者） |
 * | `status / replanCount / usage` | 可变 | Goal Runner / 用户（暂停/继续/停止） |
 * | `evidence / decisions` | **只追加** | Goal Runner |
 */

// ========== 验收 ==========

/**
 * 验收种类。
 *
 * **只保留能被确定性执行的种类**（这是「验收靠证据、不靠自述」的结构保证）：
 * - `command`：跑一条命令，比对退出码（可加输出片段）；
 * - `test`：同 command，语义标签（「这是测试」），同样比对退出码；
 * - `artifact`：检查文件存在/包含某段文本。
 *
 * 刻意**没有** `manual`：需要人判断的东西必须由用户把它改写成可执行的检查
 * （命令/产物），否则「模型自述完成」的口子会从 manual 重新打开。
 */
export type AcceptanceKind = "command" | "test" | "artifact";

export interface Acceptance {
  /** 目标级验收用 `A1..An`；阶段级验收用 `{phaseKey}.a1..an` */
  id: string;
  kind: AcceptanceKind;
  /** 给人看的一句话（门禁失败时原样呈现） */
  description: string;
  /** kind=command|test 必填 */
  command?: string;
  /** 期望退出码，默认 0 */
  expectExitCode?: number;
  /** kind=command|test：输出（stdout+stderr）必须包含这段文本（字面子串） */
  expectOutput?: string;
  /** kind=artifact 必填：相对工作区（或绝对路径，必须能读到） */
  path?: string;
  /** kind=artifact：文件内容必须包含这段文本 */
  contains?: string;
  /** 单条验收的超时（毫秒），默认 10 分钟 */
  timeoutMs?: number;
}

// ========== 预算 ==========

/**
 * 预算。
 *
 * 默认 **unlimited**：不因 token / 时间 / 轮数停止 —— 这是用户明确要求
 * （「用户预算充足时不因 token/时间/轮数停」）。`capped` 是可选上限，
 * 达限**暂停**（可继续），不是失败。
 */
export interface GoalBudget {
  mode: "unlimited" | "capped";
  /** capped：累计估算 token 上限 */
  maxTokens?: number;
  /** capped：墙钟上限（分钟） */
  maxMinutes?: number;
  /** capped：阶段回合数上限 */
  maxTurns?: number;
}

export const DEFAULT_GOAL_BUDGET: GoalBudget = { mode: "unlimited" };

// ========== 目标契约 ==========

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";

export interface GoalUsage {
  /** 估算 token（口径见 `runner.ts::estimateTurnTokens`，是估算不是账单） */
  tokens: number;
  /** 已执行的阶段回合数 */
  turns: number;
  /** 目标创建（或最近一次 resume）的时间，用于墙钟 */
  startedAt: number;
}

export interface GoalContract {
  id: string;
  sessionId: string;
  /** 用户意图的规范化重述（不是原文的复制：要能被阶段计划引用） */
  statement: string;
  /** 用户给的原则/偏好 */
  principles: string[];
  /** 明确不做的事 */
  nonGoals: string[];
  /** 整体完成的验收标准（每一条都必须能映射到阶段） */
  acceptance: Acceptance[];
  /** 技术/兼容/安全等约束 */
  constraints: string[];
  budget: GoalBudget;
  status: GoalStatus;
  /** 重规划上限（默认 5） */
  maxReplans: number;
  replanCount: number;
  usage: GoalUsage;
  /** blocked 的**具体**原因（空 = 没 blocked） */
  blockedReason?: string;
  /** 契约版本（用户改意图时 +1） */
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** 创建契约的输入（id/时间戳由 store 生成） */
export interface GoalContractInput {
  sessionId: string;
  statement: string;
  principles: string[];
  nonGoals: string[];
  acceptance: Acceptance[];
  constraints: string[];
  budget?: GoalBudget;
  maxReplans?: number;
}

// ========== 计划 ==========

export type PhaseStatus = "pending" | "active" | "done" | "blocked" | "rework";

export interface PlanPhase {
  /** 计划版本内的稳定 key：`p1`…`pN`（重规划换版本 ⇒ 新 key 空间） */
  key: string;
  /** 展示顺序（0 基） */
  order: number;
  title: string;
  /** 用户可见的交付物/行为/决策（**必须是结果，不是动作**，由 plan-validate 强制） */
  outcome: string;
  /** 本阶段完成的客观检查（至少一条确定性检查） */
  acceptance: Acceptance[];
  /** 本阶段覆盖哪些目标级验收（`GoalContract.acceptance[].id`） */
  covers: string[];
  /** 依赖的阶段 key（DAG） */
  dependsOn: string[];
  /** 本阶段的主要风险（只用于展示与提示，不参与门禁） */
  risks: string[];
  status: PhaseStatus;
  /** 已执行的执行尝试次数（Runner 唯一写者） */
  attempts: number;
  /** rework 阶段指向它要修复的已完成阶段 key（缺陷用新阶段补，不删历史） */
  reworkOf?: string;
  startedAt?: number;
  completedAt?: number;
}

export type ReplanTrigger =
  /** 证据推翻了计划假设（测试证明方案不可行、依赖不存在…） */
  | "evidence_refutes"
  /** 验收在当前约束下不可达 */
  | "acceptance_unreachable"
  /** 新方案违反不变式/非目标 */
  | "invariant_conflict"
  /** 阶段连续失败（重试用尽） */
  | "phase_failed"
  /** 用户显式改目标/原则 */
  | "user_changed_goal";

/** 允许触发重规划的**白名单**（`isReplanTrigger` 是唯一判定点） */
export const REPLAN_TRIGGERS: readonly ReplanTrigger[] = [
  "evidence_refutes",
  "acceptance_unreachable",
  "invariant_conflict",
  "phase_failed",
  "user_changed_goal",
];

export function isReplanTrigger(value: unknown): value is ReplanTrigger {
  return typeof value === "string" && (REPLAN_TRIGGERS as readonly string[]).includes(value);
}

interface PlanDiff {
  /** 新增的阶段 key */
  added: string[];
  /** 被移除的阶段 key（只允许是未完成阶段） */
  removed: string[];
  /** outcome/acceptance 发生变化的阶段 key */
  changed: string[];
}

export interface PlanRevision {
  fromVersion: number;
  trigger: ReplanTrigger;
  /** 为什么重规划（人可读） */
  reason: string;
  /** 触发它的证据 id（**不能为空**：无证据不许重规划） */
  evidenceIds: string[];
  diff: PlanDiff;
  at: number;
}

export interface GoalPlan {
  goalId: string;
  version: number;
  /** 生成这份计划时的契约版本（用户改意图后 ⇒ 旧计划需要重规划） */
  contractVersion: number;
  /** 总体策略（一段话，说明为什么选这条路径） */
  strategy: string;
  /** 执行期间必须始终成立的不变式（至少包含用户原则/安全边界） */
  invariants: string[];
  phases: PlanPhase[];
  createdAt: number;
  /** v1 为空；重规划版本必须带完整触发信息 */
  revision?: PlanRevision;
}

// ========== 证据 ==========

export interface GoalEvidence {
  id: string;
  goalId: string;
  planVersion: number;
  phaseKey: string;
  /** 第几次执行尝试（1 基；0 = 目标级最终验收） */
  attempt: number;
  kind: AcceptanceKind;
  /** 这条证据对应的验收 id（`A1` / `p1.a1`） */
  acceptanceId: string;
  /** 一句话结果（失败时是**具体原因**，不是「失败了」） */
  summary: string;
  /** 有界详情（命令输出尾部等） */
  detail?: string;
  passed: boolean;
  createdAt: number;
}

export interface AcceptanceResult {
  acceptance: Acceptance;
  passed: boolean;
  summary: string;
  detail?: string;
  /** 命令退出码（kind=command|test 时有值；无法执行时为 undefined） */
  exitCode?: number;
  durationMs: number;
}

// ========== 决策 ==========

export type GoalDecisionKind =
  | "goal_created"
  | "plan_created"
  | "plan_rejected"
  | "plan_replanned"
  | "plan_blocked"
  | "phase_started"
  | "phase_passed"
  | "phase_failed"
  | "phase_interrupted"
  /** 阶段内「无 tool call 且验收未达」触发的自动继续（A1 / GOAL-16） */
  | "auto_continue"
  /** 压缩前写检查点（A2 / GOAL-17） */
  | "phase_checkpoint"
  /** 压缩后从检查点恢复（A2 / GOAL-17） */
  | "phase_resumed"
  | "goal_completed"
  | "goal_blocked"
  | "goal_paused"
  | "goal_resumed"
  | "goal_stopped"
  /** 用户主动取消（结束，不可继续） */
  | "goal_cancelled"
  | "budget_capped"
  | "approval_required"
  | "approval_resolved"
  | "contract_change_requested"
  | "contract_changed";

export interface GoalDecision {
  id: string;
  goalId: string;
  kind: GoalDecisionKind;
  /** 人可读原因（审计入口；空原因 = 缺陷） */
  reason: string;
  planVersion?: number;
  phaseKey?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

// ========== 任务分类（自动选择自主级别） ==========

/**
 * 规划器对任务的分类。
 *
 * - `question`：纯问答/解释 —— 不建目标、不自动继续；
 * - `single-phase`：一个可验收交付 —— 走 run 自主（现有 `runAgenticLoop`）；
 * - `multi-phase`：多个里程碑 —— 进入目标模式。
 *
 * 分类由**一次只读深规划调用**同时给出（避免"先分类再规划"两次模型往返）。
 */
export type TaskClassification = "question" | "single-phase" | "multi-phase";

// ========== 运行状态（UI/上下文注入共用） ==========

export interface GoalView {
  sessionId: string;
  goalId: string;
  status: GoalStatus;
  statement: string;
  /** 计划版本（0 = 还没有计划） */
  planVersion: number;
  phaseTotal: number;
  /** 已完成阶段数 */
  phaseDone: number;
  /** 当前阶段（active）的 key/标题/outcome；没有 active 阶段时为空 */
  activePhase?: { key: string; title: string; outcome: string; index: number };
  /** 当前阶段之前已完成的阶段标题（给状态条上的一句话进度） */
  lastCompleted?: { key: string; title: string };
  replanCount: number;
  maxReplans: number;
  /** 阶段内自动继续的次数（A1：模型自然语言收尾但验收未达时的自动续跑） */
  autoContinues: number;
  budget: GoalBudget;
  usage: GoalUsage;
  blockedReason?: string;
  /** 最近一条失败证据（给用户看「卡在哪」） */
  lastFailure?: string;
  updatedAt: number;
}
