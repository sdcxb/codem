/**
 * 目标存储：`goal_contracts` / `goal_plans` / `goal_phases` / `goal_evidence` / `goal_decisions`。
 *
 * 设计依据 `GOAL-MODE-PLAN.md` §9。三个硬约定：
 *
 * 1. **同步接口**：上下文注入在 agent 循环里每轮同步发生（与旧 `goals` 注入同形），
 *    所以读写都走**内存镜像**（行读写委托给数据层 `storage/goal-domain.ts`），不引入 await；
 * 2. **一个会话最多一个 active goal**（`createGoal` 会拒绝第二个 —— 这是不变量，不是建议）；
 * 3. **JSON 列原样存字符串**，读写两侧都显式 parse（`wire → 领域对象` 的转换函数逐列列出，
 *    缺列会被写成 NULL 而不是静默读空 —— 与 `src/core/goal/goal.ts` 同一条纪律）。
 *
 * 测试用 `createMemoryGoalStore()`：Goal Runner 的判据不该依赖存储镜像的异步就绪
 * （那是存储层的判据，另有 `goal-store-persist` 覆盖）。
 */

import {
  readGoalRows,
  reportGoalMissing,
  reportGoalPhaseMissing,
  writeGoalRows,
} from "../storage/goal-domain";
import type { GoalDomainTable } from "../storage/goal-domain";
import type {
  Acceptance,
  GoalBudget,
  GoalContract,
  GoalContractInput,
  GoalDecision,
  GoalDecisionKind,
  GoalEvidence,
  GoalPlan,
  GoalStatus,
  GoalUsage,
  PhaseStatus,
  PlanPhase,
  PlanRevision,
} from "./types";
import { DEFAULT_GOAL_BUDGET } from "./types";

const T_CONTRACTS = "goal_contracts";
const T_PLANS = "goal_plans";
const T_PHASES = "goal_phases";
const T_EVIDENCE = "goal_evidence";
const T_DECISIONS = "goal_decisions";

/** 一个会话里同时只能有一个「还活着」的目标（active/blocked 都算，paused 不算占用） */
const OCCUPYING_STATUSES: GoalStatus[] = ["active", "blocked"];

export interface GoalStore {
  createGoal(input: GoalContractInput, opts?: { now?: number; id?: string }): GoalContract;
  getGoal(goalId: string): GoalContract | null;
  /** 该会话当前「还活着」的目标（active/blocked；没有返回 null） */
  getLiveGoalForSession(sessionId: string): GoalContract | null;
  /** 该会话最近一个目标（含 completed/paused），用于 UI 展示历史 */
  getLatestGoalForSession(sessionId: string): GoalContract | null;
  listGoalsForSession(sessionId: string): GoalContract[];
  /** 只允许改运行态字段（契约字段走 `replaceContract`） */
  updateGoal(
    goalId: string,
    patch: Partial<Pick<GoalContract, "status" | "replanCount" | "blockedReason" | "completedAt" | "updatedAt">> & {
      usage?: GoalUsage;
    },
  ): void;
  /** 用户确认后的契约变更（bump version；调用方必须已拿到用户确认） */
  replaceContract(next: GoalContract): void;

  savePlan(plan: GoalPlan): void;
  /** 最高版本的计划（含阶段行）；没有返回 null */
  getActivePlan(goalId: string): GoalPlan | null;
  listPlans(goalId: string): GoalPlan[];
  updatePhase(goalId: string, planVersion: number, phaseKey: string, patch: Partial<PlanPhase>): void;
  listPhases(goalId: string, planVersion: number): PlanPhase[];

  addEvidence(e: GoalEvidence): void;
  listEvidence(goalId: string, opts?: { phaseKey?: string; planVersion?: number; limit?: number }): GoalEvidence[];
  addDecision(d: GoalDecision): void;
  listDecisions(goalId: string, opts?: { limit?: number }): GoalDecision[];
}

// ========== wire ↔ 领域对象 ==========

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function str(raw: unknown, fallback = ""): string {
  return typeof raw === "string" ? raw : raw == null ? fallback : String(raw);
}

function num(raw: unknown, fallback = 0): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function wireToContract(row: Record<string, unknown>): GoalContract {
  const usage: GoalUsage = parseJson<GoalUsage>(row.usage, {
    tokens: 0,
    turns: 0,
    startedAt: num(row.started_at),
  });
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    statement: str(row.statement),
    principles: parseJson<string[]>(row.principles, []),
    nonGoals: parseJson<string[]>(row.non_goals, []),
    acceptance: parseJson<Acceptance[]>(row.acceptance, []),
    constraints: parseJson<string[]>(row.constraints, []),
    budget: parseJson<GoalBudget>(row.budget, DEFAULT_GOAL_BUDGET),
    status: (str(row.status, "active") as GoalStatus),
    maxReplans: num(row.max_replans, 5),
    replanCount: num(row.replan_count, 0),
    usage,
    ...(str(row.blocked_reason) ? { blockedReason: str(row.blocked_reason) } : {}),
    version: num(row.version, 1),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    ...(row.completed_at != null ? { completedAt: num(row.completed_at) } : {}),
  };
}

function contractToWire(c: GoalContract): Record<string, unknown> {
  return {
    id: c.id,
    session_id: c.sessionId,
    statement: c.statement,
    principles: JSON.stringify(c.principles),
    non_goals: JSON.stringify(c.nonGoals),
    acceptance: JSON.stringify(c.acceptance),
    constraints: JSON.stringify(c.constraints),
    budget: JSON.stringify(c.budget),
    status: c.status,
    max_replans: c.maxReplans,
    replan_count: c.replanCount,
    usage: JSON.stringify(c.usage),
    started_at: c.usage.startedAt,
    blocked_reason: c.blockedReason ?? null,
    version: c.version,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    completed_at: c.completedAt ?? null,
  };
}

function wireToPhase(row: Record<string, unknown>): PlanPhase {
  return {
    key: str(row.phase_key),
    order: num(row.order_index),
    title: str(row.title),
    outcome: str(row.outcome),
    acceptance: parseJson<Acceptance[]>(row.acceptance, []),
    covers: parseJson<string[]>(row.covers, []),
    dependsOn: parseJson<string[]>(row.depends_on, []),
    risks: parseJson<string[]>(row.risks, []),
    status: str(row.status, "pending") as PhaseStatus,
    attempts: num(row.attempts),
    ...(str(row.rework_of) ? { reworkOf: str(row.rework_of) } : {}),
    ...(row.started_at != null ? { startedAt: num(row.started_at) } : {}),
    ...(row.completed_at != null ? { completedAt: num(row.completed_at) } : {}),
  };
}

function phaseRowId(goalId: string, version: number, key: string): string {
  return `${goalId}:v${version}:${key}`;
}

function planRowId(goalId: string, version: number): string {
  return `${goalId}:v${version}`;
}

function wireToPlan(row: Record<string, unknown>, phases: PlanPhase[]): GoalPlan {
  return {
    goalId: str(row.goal_id),
    version: num(row.version, 1),
    contractVersion: num(row.contract_version, 1),
    strategy: str(row.strategy),
    invariants: parseJson<string[]>(row.invariants, []),
    phases,
    createdAt: num(row.created_at),
    ...(row.revision ? { revision: parseJson<PlanRevision | undefined>(row.revision, undefined) } : {}),
  };
}

function wireToEvidence(row: Record<string, unknown>): GoalEvidence {
  return {
    id: str(row.id),
    goalId: str(row.goal_id),
    planVersion: num(row.plan_version, 1),
    phaseKey: str(row.phase_key),
    attempt: num(row.attempt),
    kind: str(row.kind, "command") as GoalEvidence["kind"],
    acceptanceId: str(row.acceptance_id),
    summary: str(row.summary),
    ...(str(row.detail) ? { detail: str(row.detail) } : {}),
    passed: num(row.passed) === 1,
    createdAt: num(row.created_at),
  };
}

function evidenceToWire(e: GoalEvidence): Record<string, unknown> {
  return {
    id: e.id,
    goal_id: e.goalId,
    plan_version: e.planVersion,
    phase_key: e.phaseKey,
    attempt: e.attempt,
    kind: e.kind,
    acceptance_id: e.acceptanceId,
    summary: e.summary,
    detail: e.detail ?? null,
    passed: e.passed ? 1 : 0,
    created_at: e.createdAt,
  };
}

function wireToDecision(row: Record<string, unknown>): GoalDecision {
  const payload = parseJson<Record<string, unknown> | undefined>(row.payload, undefined);
  return {
    id: str(row.id),
    goalId: str(row.goal_id),
    kind: str(row.kind, "goal_created") as GoalDecisionKind,
    reason: str(row.reason),
    ...(row.plan_version != null ? { planVersion: num(row.plan_version) } : {}),
    ...(str(row.phase_key) ? { phaseKey: str(row.phase_key) } : {}),
    ...(payload ? { payload } : {}),
    createdAt: num(row.created_at),
  };
}

function decisionToWire(d: GoalDecision): Record<string, unknown> {
  return {
    id: d.id,
    goal_id: d.goalId,
    kind: d.kind,
    reason: d.reason,
    plan_version: d.planVersion ?? null,
    phase_key: d.phaseKey ?? null,
    payload: d.payload ? JSON.stringify(d.payload) : null,
    created_at: d.createdAt,
  };
}

// ========== id 生成 ==========

function newId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ========== SQLite（domain 镜像）实现 ==========

/**
 * 生产实现。
 *
 * 行读写全部走 `../storage/goal-domain`（数据层）：那里的失败上报是**唯一**通道，
 * 这里不重复写一遍"写失败要报"的逻辑（两份口径必然漂移）。
 */
export class SqliteGoalStore implements GoalStore {
  constructor(private readonly now: () => number = Date.now) {}

  private write(table: GoalDomainTable, rows: Array<Record<string, unknown>>): void {
    writeGoalRows(table, rows);
  }

  createGoal(input: GoalContractInput, opts: { now?: number; id?: string } = {}): GoalContract {
    const existing = this.getLiveGoalForSession(input.sessionId);
    if (existing) {
      throw new Error(
        `会话 ${input.sessionId} 已有活跃目标 ${existing.id}（一个会话最多一个 active goal —— 先暂停/完成它再建新的）`,
      );
    }
    const now = opts.now ?? this.now();
    const contract: GoalContract = {
      id: opts.id ?? newId("goal", now),
      sessionId: input.sessionId,
      statement: input.statement,
      principles: input.principles,
      nonGoals: input.nonGoals,
      acceptance: input.acceptance,
      constraints: input.constraints,
      budget: input.budget ?? DEFAULT_GOAL_BUDGET,
      status: "active",
      maxReplans: input.maxReplans ?? 5,
      replanCount: 0,
      usage: { tokens: 0, turns: 0, startedAt: now },
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.write(T_CONTRACTS, [contractToWire(contract)]);
    return contract;
  }

  getGoal(goalId: string): GoalContract | null {
    const rows = readGoalRows(T_CONTRACTS, wireToContract, { id: goalId });
    return rows && rows.length > 0 ? rows[0] : null;
  }

  getLiveGoalForSession(sessionId: string): GoalContract | null {
    const rows = readGoalRows(T_CONTRACTS, wireToContract, { session_id: sessionId }) ?? [];
    const live = rows
      .filter((c) => OCCUPYING_STATUSES.includes(c.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return live[0] ?? null;
  }

  getLatestGoalForSession(sessionId: string): GoalContract | null {
    const rows = readGoalRows(T_CONTRACTS, wireToContract, { session_id: sessionId }) ?? [];
    const sorted = rows.sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0] ?? null;
  }

  listGoalsForSession(sessionId: string): GoalContract[] {
    const rows = readGoalRows(T_CONTRACTS, wireToContract, { session_id: sessionId }) ?? [];
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  updateGoal(
    goalId: string,
    patch: Partial<Pick<GoalContract, "status" | "replanCount" | "blockedReason" | "completedAt" | "updatedAt">> & {
      usage?: GoalUsage;
    },
  ): void {
    const current = this.getGoal(goalId);
    if (!current) {
      reportGoalMissing();
      return;
    }
    const next: GoalContract = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.replanCount !== undefined ? { replanCount: patch.replanCount } : {}),
      ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
      ...(patch.blockedReason !== undefined
        ? patch.blockedReason
          ? { blockedReason: patch.blockedReason }
          : { blockedReason: undefined }
        : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      updatedAt: patch.updatedAt ?? this.now(),
    };
    this.write(T_CONTRACTS, [contractToWire(next)]);
  }

  replaceContract(next: GoalContract): void {
    this.write(T_CONTRACTS, [contractToWire(next)]);
  }

  savePlan(plan: GoalPlan): void {
    const now = this.now();
    this.write(
      T_PLANS,
      [
        {
          id: planRowId(plan.goalId, plan.version),
          goal_id: plan.goalId,
          version: plan.version,
          contract_version: plan.contractVersion,
          strategy: plan.strategy,
          invariants: JSON.stringify(plan.invariants),
          revision: plan.revision ? JSON.stringify(plan.revision) : null,
          created_at: plan.createdAt || now,
        },
      ],
    );
    const rows = plan.phases.map((p) => ({
      id: phaseRowId(plan.goalId, plan.version, p.key),
      goal_id: plan.goalId,
      plan_version: plan.version,
      phase_key: p.key,
      order_index: p.order,
      title: p.title,
      outcome: p.outcome,
      acceptance: JSON.stringify(p.acceptance),
      covers: JSON.stringify(p.covers),
      depends_on: JSON.stringify(p.dependsOn),
      risks: JSON.stringify(p.risks),
      status: p.status,
      attempts: p.attempts,
      rework_of: p.reworkOf ?? null,
      started_at: p.startedAt ?? null,
      completed_at: p.completedAt ?? null,
    }));
    if (rows.length > 0) this.write(T_PHASES, rows);
  }

  getActivePlan(goalId: string): GoalPlan | null {
    const plans = this.listPlans(goalId);
    return plans.length > 0 ? plans[plans.length - 1] : null;
  }

  listPlans(goalId: string): GoalPlan[] {
    const rows = readGoalRows(T_PLANS, (r) => r, { goal_id: goalId }) ?? [];
    return rows
      .sort((a, b) => num(a.version) - num(b.version))
      .map((row) => {
        const version = num(row.version, 1);
        return wireToPlan(row, this.listPhases(goalId, version));
      });
  }

  listPhases(goalId: string, planVersion: number): PlanPhase[] {
    const rows = readGoalRows(T_PHASES, wireToPhase, { goal_id: goalId, plan_version: planVersion }) ?? [];
    return rows.sort((a, b) => a.order - b.order);
  }

  updatePhase(goalId: string, planVersion: number, phaseKey: string, patch: Partial<PlanPhase>): void {
    const phases = this.listPhases(goalId, planVersion);
    const current = phases.find((p) => p.key === phaseKey);
    if (!current) {
      reportGoalPhaseMissing(phaseKey);
      return;
    }
    const next: PlanPhase = { ...current, ...patch };
    this.write(
      T_PHASES,
      [
        {
          id: phaseRowId(goalId, planVersion, phaseKey),
          goal_id: goalId,
          plan_version: planVersion,
          phase_key: next.key,
          order_index: next.order,
          title: next.title,
          outcome: next.outcome,
          acceptance: JSON.stringify(next.acceptance),
          covers: JSON.stringify(next.covers),
          depends_on: JSON.stringify(next.dependsOn),
          risks: JSON.stringify(next.risks),
          status: next.status,
          attempts: next.attempts,
          rework_of: next.reworkOf ?? null,
          started_at: next.startedAt ?? null,
          completed_at: next.completedAt ?? null,
        },
      ],
    );
  }

  addEvidence(e: GoalEvidence): void {
    this.write(T_EVIDENCE, [evidenceToWire(e)]);
  }

  listEvidence(goalId: string, opts: { phaseKey?: string; planVersion?: number; limit?: number } = {}): GoalEvidence[] {
    const rows = readGoalRows(T_EVIDENCE, wireToEvidence, { goal_id: goalId }) ?? [];
    let list = rows.sort((a, b) => a.createdAt - b.createdAt);
    if (opts.phaseKey) list = list.filter((e) => e.phaseKey === opts.phaseKey);
    if (opts.planVersion !== undefined) list = list.filter((e) => e.planVersion === opts.planVersion);
    if (opts.limit !== undefined) list = list.slice(Math.max(0, list.length - opts.limit));
    return list;
  }

  addDecision(d: GoalDecision): void {
    this.write(T_DECISIONS, [decisionToWire(d)]);
  }

  listDecisions(goalId: string, opts: { limit?: number } = {}): GoalDecision[] {
    const rows = readGoalRows(T_DECISIONS, wireToDecision, { goal_id: goalId }) ?? [];
    const list = rows.sort((a, b) => a.createdAt - b.createdAt);
    return opts.limit !== undefined ? list.slice(Math.max(0, list.length - opts.limit)) : list;
  }
}

// ========== 内存实现（判据用；也用于「端口没就绪」时不让调用方崩） ==========

/**
 * 内存实现。
 *
 * ⚠️ **不是生产回退**：生产里端口未就绪时宁可如实上报失败，也不能把目标悄悄存在内存里
 * （重启即丢 = 假持久化）。这里只给判据用，避免 Goal Runner 的判据依赖存储镜像的异步就绪。
 */
export function createMemoryGoalStore(now: () => number = Date.now): GoalStore {
  const goals = new Map<string, GoalContract>();
  const plans = new Map<string, GoalPlan[]>(); // goalId → 按 version 升序
  const phases = new Map<string, PlanPhase[]>(); // `${goalId}:v${version}` → phases
  const evidence = new Map<string, GoalEvidence[]>();
  const decisions = new Map<string, GoalDecision[]>();

  const phaseMapKey = (goalId: string, version: number) => `${goalId}:v${version}`;
  const clone = <T>(v: T): T => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  return {
    createGoal(input, opts = {}) {
      const existing = this.getLiveGoalForSession(input.sessionId);
      if (existing) throw new Error(`会话 ${input.sessionId} 已有活跃目标 ${existing.id}（一个会话最多一个 active goal）`);
      const at = opts.now ?? now();
      const contract: GoalContract = {
        id: opts.id ?? newId("goal", at),
        sessionId: input.sessionId,
        statement: input.statement,
        principles: [...input.principles],
        nonGoals: [...input.nonGoals],
        acceptance: clone(input.acceptance),
        constraints: [...input.constraints],
        budget: input.budget ?? DEFAULT_GOAL_BUDGET,
        status: "active",
        maxReplans: input.maxReplans ?? 5,
        replanCount: 0,
        usage: { tokens: 0, turns: 0, startedAt: at },
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      goals.set(contract.id, contract);
      return clone(contract);
    },
    getGoal(goalId) {
      const g = goals.get(goalId);
      return g ? clone(g) : null;
    },
    getLiveGoalForSession(sessionId) {
      const live = [...goals.values()]
        .filter((g) => g.sessionId === sessionId && OCCUPYING_STATUSES.includes(g.status))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return live[0] ? clone(live[0]) : null;
    },
    getLatestGoalForSession(sessionId) {
      const list = [...goals.values()].filter((g) => g.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt);
      return list[0] ? clone(list[0]) : null;
    },
    listGoalsForSession(sessionId) {
      return [...goals.values()]
        .filter((g) => g.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
    },
    updateGoal(goalId, patch) {
      const current = goals.get(goalId);
      if (!current) return;
      const next: GoalContract = {
        ...current,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.replanCount !== undefined ? { replanCount: patch.replanCount } : {}),
        ...(patch.usage !== undefined ? { usage: clone(patch.usage) } : {}),
        ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason || undefined } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        updatedAt: patch.updatedAt ?? now(),
      };
      goals.set(goalId, next);
    },
    replaceContract(next) {
      goals.set(next.id, clone(next));
    },
    savePlan(plan) {
      const list = plans.get(plan.goalId) ?? [];
      const filtered = list.filter((p) => p.version !== plan.version);
      filtered.push(clone(plan));
      plans.set(plan.goalId, filtered.sort((a, b) => a.version - b.version));
      phases.set(phaseMapKey(plan.goalId, plan.version), clone(plan.phases));
    },
    getActivePlan(goalId) {
      const list = plans.get(goalId) ?? [];
      if (list.length === 0) return null;
      const latest = list[list.length - 1];
      // ⚠️ 阶段状态是**独立存放**的（updatePhase 只改 phases map）—— 这里必须重新取，
      // 否则调用方拿到的是保存那一刻的快照（判据里表现为"阶段永远 pending ⇒ 无限重跑"）。
      return { ...clone(latest), phases: clone(phases.get(phaseMapKey(goalId, latest.version)) ?? []) };
    },
    listPlans(goalId) {
      return (plans.get(goalId) ?? []).map((p) => ({
        ...clone(p),
        phases: clone(phases.get(phaseMapKey(goalId, p.version)) ?? []),
      }));
    },
    updatePhase(goalId, planVersion, phaseKey, patch) {
      const key = phaseMapKey(goalId, planVersion);
      const list = phases.get(key) ?? [];
      const idx = list.findIndex((p) => p.key === phaseKey);
      if (idx < 0) return;
      list[idx] = { ...list[idx], ...clone(patch) };
      phases.set(key, list);
    },
    listPhases(goalId, planVersion) {
      return clone(phases.get(phaseMapKey(goalId, planVersion)) ?? []);
    },
    addEvidence(e) {
      const list = evidence.get(e.goalId) ?? [];
      list.push(clone(e));
      evidence.set(e.goalId, list);
    },
    listEvidence(goalId, opts = {}) {
      let list = clone(evidence.get(goalId) ?? []).sort((a, b) => a.createdAt - b.createdAt);
      if (opts.phaseKey) list = list.filter((e) => e.phaseKey === opts.phaseKey);
      if (opts.planVersion !== undefined) list = list.filter((e) => e.planVersion === opts.planVersion);
      if (opts.limit !== undefined) list = list.slice(Math.max(0, list.length - opts.limit));
      return list;
    },
    addDecision(d) {
      const list = decisions.get(d.goalId) ?? [];
      list.push(clone(d));
      decisions.set(d.goalId, list);
    },
    listDecisions(goalId, opts = {}) {
      const list = clone(decisions.get(goalId) ?? []).sort((a, b) => a.createdAt - b.createdAt);
      return opts.limit !== undefined ? list.slice(Math.max(0, list.length - opts.limit)) : list;
    },
  };
}

// ========== 单例 ==========

let storeInstance: GoalStore | null = null;

/** 生产单例（测试请直接 `new SqliteGoalStore()` 或 `createMemoryGoalStore()`，不要用这个） */
export function getGoalStore(): GoalStore {
  if (!storeInstance) storeInstance = new SqliteGoalStore();
  return storeInstance;
}
