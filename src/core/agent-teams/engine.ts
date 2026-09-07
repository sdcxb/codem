/**
 * @codem/agent-teams — 引擎（纯逻辑层，不依赖 UI / subagent runtime）
 *
 * 职责：团队 CRUD、成员管理、任务状态机（依赖满足判定 / attempt 令牌 /
 * 转派撤销）、邮箱投递租赁。所有函数同步、幂等、无副作用（读写均由调用方
 * 持久化），便于单元测试。
 *
 * 状态并发语义：单进程内由 AgentTeamsService 串行化调用（对标 EAC 的
 * withTeamLock + serializeMember——本实现把锁收敛到服务层一个 mutex）。
 */

import {
  AgentTeam, TeamMember, TeamTask, TeamTaskStatus, MailboxMessage, MemberStatus,
  TASK_TERMINAL, TASK_TRANSITIONS, canTransition, MAILBOX_LEASE_MS, CAPTAIN,
} from "./types";

// ========== 小工具 ==========

export function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function genAttemptId(): string {
  return crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

// ========== 团队创建 ==========

export function createTeam(input: { name: string; captainSessionId: string }): AgentTeam {
  const now = Date.now();
  return {
    id: genId("team"),
    name: input.name,
    captainSessionId: input.captainSessionId,
    members: [],
    tasks: [],
    mailbox: [],
    taskSeq: 0,
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
}

// ========== 成员管理 ==========

export function addMember(team: AgentTeam, input: {
  id: string; name: string; role?: string;
  provider?: string; model?: string; reasoningEffort?: "low" | "medium" | "high";
}): { team: AgentTeam; member: TeamMember } {
  const now = Date.now();
  if (team.members.some((m) => m.name === input.name)) {
    throw new Error(`member "${input.name}" already exists`);
  }
  const member: TeamMember = {
    id: input.id,
    name: input.name,
    role: input.role,
    status: "idle",
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    addedAt: now,
  };
  team.members.push(member);
  touch(team);
  return { team, member };
}

/** 标记移除：撤销其全部未完成任务回共享池（attempt 失效） */
export function removeMember(team: AgentTeam, name: string): { team: AgentTeam; removed: TeamMember } {
  const member = team.members.find((m) => m.name === name);
  if (!member) throw new Error(`member "${name}" not found`);
  member.status = "removed";
  // 撤销其持有的所有非终态任务：status→pending、assignee→undefined、清令牌
  for (const t of team.tasks) {
    if (t.assignee === name && !TASK_TERMINAL.has(t.status)) {
      invalidateTask(team, t, undefined);
    }
  }
  touch(team);
  return { team, removed: member };
}

// ========== 任务管理 ==========

export function createTask(team: AgentTeam, input: {
  subject: string; description?: string; dependencies?: string[]; assignee?: string;
}): { team: AgentTeam; task: TeamTask } {
  const now = Date.now();
  // 校验依赖存在
  for (const dep of input.dependencies ?? []) {
    if (!team.tasks.some((t) => t.id === dep)) {
      throw new Error(`dependency task "${dep}" does not exist`);
    }
  }
  // 校验 assignee
  if (input.assignee && input.assignee !== CAPTAIN && !team.members.some((m) => m.name === input.assignee)) {
    throw new Error(`assignee "${input.assignee}" is not a member`);
  }
  const id = `t${++team.taskSeq}`;
  const task: TeamTask = {
    id,
    subject: input.subject,
    description: input.description,
    status: "pending",
    assignee: input.assignee,
    dependencies: input.dependencies ?? [],
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
  team.tasks.push(task);
  touch(team);
  return { team, task };
}

export function getTask(team: AgentTeam, id: string): TeamTask {
  const t = team.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task "${id}" not found`);
  return t;
}

/** 依赖是否全部完成 */
export function depsSatisfied(team: AgentTeam, task: TeamTask): boolean {
  for (const dep of task.dependencies) {
    const d = team.tasks.find((t) => t.id === dep);
    if (!d || d.status !== "completed") return false;
  }
  return true;
}

/** 下一件就绪任务：依赖满足且未指派（共享池）或指派给自己；非 reassigning */
export function nextReadyTask(team: AgentTeam, memberName: string): TeamTask | undefined {
  return team.tasks.find((t) =>
    t.status === "pending" &&
    !t.reassigning &&
    depsSatisfied(team, t) &&
    (t.assignee === undefined || t.assignee === memberName),
  );
}

function touch(team: AgentTeam): void {
  team.updatedAt = Date.now();
}

/**
 * 原子领取（对标 EAC beginTaskAttempt）：
 * - 依赖不满足 / 已被他人认领 / reassigning 静默期 → 报错
 * - 幂等：已 claimed/in_progress 且 assignee 匹配 → 直接返回当前 attemptId
 */
export function claimTask(team: AgentTeam, taskId: string, by: string): { team: AgentTeam; attemptId: string; attempt: number } {
  const task = getTask(team, taskId);
  // 幂等命中
  if ((task.status === "claimed" || task.status === "in_progress") && task.assignee === by) {
    return { team, attemptId: task.attemptId!, attempt: task.attempt };
  }
  if (TASK_TERMINAL.has(task.status)) throw new Error(`task "${taskId}" already ${task.status}`);
  if (task.reassigning) throw new Error(`task "${taskId}" is being reassigned; try later`);
  if (task.assignee && task.assignee !== by) throw new Error(`task "${taskId}" is assigned to "${task.assignee}"`);
  if (!depsSatisfied(team, task)) {
    const missing = task.dependencies.filter((d) => team.tasks.find((t) => t.id === d)?.status !== "completed");
    throw new Error(`task "${taskId}" has unsatisfied dependencies: ${missing.join(", ")}`);
  }
  task.assignee = by;
  task.status = "claimed";
  task.attempt = task.attempt + 1;
  task.attemptId = genAttemptId();
  task.updatedAt = Date.now();
  touch(team);
  return { team, attemptId: task.attemptId, attempt: task.attempt };
}

/**
 * 更新任务（对标 EAC update_task）：成员必须带当前 attemptId（stale 拒绝）；
 * 终态幂等（重复 completed 带相同 attempt 返回成功）。写完 kickTeam 由调用方做。
 */
export function updateTask(team: AgentTeam, taskId: string, input: {
  status: TeamTaskStatus; output?: string; attemptId?: string; by: string;
}): { team: AgentTeam; task: TeamTask } {
  const task = getTask(team, taskId);
  // attempt 校验：仅当持有 attemptId 且目标非终态幂等确认时
  if (task.attemptId && input.attemptId && task.attemptId !== input.attemptId) {
    throw new Error(`stale attempt for task "${taskId}": task was reassigned (use agent_teams_status to see current owner)`);
  }
  if (!canTransition(task.status, input.status)) {
    // 终态重复同态且带原 attempt → 视为幂等成功
    if (TASK_TERMINAL.has(task.status) && task.status === input.status) {
      if (input.output) task.output = input.output;
      return { team, task };
    }
    throw new Error(`invalid transition ${task.status} → ${input.status} for task "${taskId}"`);
  }
  task.status = input.status;
  if (input.output) task.output = input.output;
  task.updatedAt = Date.now();
  if (TASK_TERMINAL.has(input.status)) {
    // 进入终态：清令牌与交接标记
    task.attemptId = undefined;
    task.reassigning = false;
    task.handoffId = undefined;
  }
  touch(team);
  return { team, task };
}

/**
 * 转派 / 队长接管（对标 EAC reassign_task）：
 * 撤销旧 attempt → 记 handoff → 置 reassigning 静默期（由服务层中断旧成员并等
 * 静默后，对新 assignee 重新 beginTaskAttempt）。本函数负责状态侧。
 */
export function beginReassign(team: AgentTeam, taskId: string, newAssignee: string): { team: AgentTeam; task: TeamTask; previousAssignee?: string } {
  const task = getTask(team, taskId);
  if (TASK_TERMINAL.has(task.status)) throw new Error(`task "${taskId}" already ${task.status} — cannot reassign`);
  const previousAssignee = task.assignee;
  task.handoffId = genId("ho");
  task.reassigning = true;
  task.assignee = newAssignee === CAPTAIN ? CAPTAIN : newAssignee; // 目标占位
  task.status = "pending";        // 回池，防止幂等分支吞掉新 attempt
  task.attemptId = undefined;     // 旧令牌作废
  task.updatedAt = Date.now();
  touch(team);
  return { team, task, previousAssignee };
}

/** 交接静默期结束：对新 assignee 开新 attempt（队长接管 → claimed） */
export function finishReassign(team: AgentTeam, taskId: string, by: string): { team: AgentTeam; task: TeamTask } {
  const task = getTask(team, taskId);
  if (!task.reassigning) throw new Error(`task "${taskId}" is not in reassignment`);
  task.reassigning = false;
  task.handoffId = undefined;
  const r = claimTask(team, taskId, by); // pending → 正式领取，attempt++
  return { team, task: getTask(team, taskId) };
}

/** 回滚一次领取（投递失败时，仅当 attemptId 仍是我们开的） */
export function rollbackClaim(team: AgentTeam, taskId: string, attemptId: string, toAssignee?: string): { team: AgentTeam; task: TeamTask } {
  const task = getTask(team, taskId);
  if (task.attemptId !== attemptId) return { team, task }; // 已被并发转派，不动
  task.status = "pending";
  task.assignee = toAssignee;
  task.attemptId = undefined;
  task.reassigning = false;
  task.handoffId = undefined;
  task.updatedAt = Date.now();
  touch(team);
  return { team, task };
}

function invalidateTask(team: AgentTeam, task: TeamTask, toAssignee?: string): void {
  task.status = "pending";
  task.assignee = toAssignee;
  task.attemptId = undefined;
  task.reassigning = false;
  task.handoffId = undefined;
  task.updatedAt = Date.now();
}

// ========== 邮箱 ==========

export function appendMailbox(team: AgentTeam, msg: { to: string; from: string; content: string }): MailboxMessage {
  const m: MailboxMessage = {
    id: genId("mail"),
    to: msg.to,
    from: msg.from,
    content: msg.content,
    createdAt: Date.now(),
  };
  team.mailbox.push(m);
  touch(team);
  return m;
}

/** 未投递（无 deliveredAt）且租赁未过期或已过期（可重投）的收件 */
export function unreadMailbox(team: AgentTeam, to: string, now = Date.now()): MailboxMessage[] {
  return team.mailbox.filter((m) =>
    m.to === to &&
    m.deliveredAt === undefined &&
    (m.claimedAt === undefined || now - m.claimedAt > MAILBOX_LEASE_MS),
  );
}

export function claimMailbox(team: AgentTeam, ids: string[], now = Date.now()): void {
  for (const m of team.mailbox) {
    if (ids.includes(m.id) && m.deliveredAt === undefined) m.claimedAt = now;
  }
}

export function acknowledgeMailbox(team: AgentTeam, ids: string[]): void {
  for (const m of team.mailbox) {
    if (ids.includes(m.id)) m.deliveredAt = Date.now();
  }
}

export function releaseMailbox(team: AgentTeam, ids: string[]): void {
  for (const m of team.mailbox) {
    if (ids.includes(m.id)) { m.claimedAt = undefined; m.deliveredAt = undefined; }
  }
}

// ========== 团队状态快照（供 status 工具 / UI） ==========

export interface TeamSnapshot {
  id: string;
  name: string;
  captainSessionId: string;
  members: Array<{ id: string; name: string; role?: string; status: MemberStatus; provider?: string; model?: string }>;
  tasks: Array<{ id: string; subject: string; status: TeamTaskStatus; assignee?: string; dependencies: string[]; attempt: number; hasAttemptId: boolean; output?: string }>;
  unreadFor: Record<string, number>; // 收件人 → 未读条数
}

export function snapshot(team: AgentTeam): TeamSnapshot {
  const unreadFor: Record<string, number> = {};
  for (const m of team.mailbox) {
    if (m.deliveredAt === undefined) unreadFor[m.to] = (unreadFor[m.to] ?? 0) + 1;
  }
  return {
    id: team.id,
    name: team.name,
    captainSessionId: team.captainSessionId,
    members: team.members.map((m) => ({
      id: m.id, name: m.name, role: m.role, status: m.status, provider: m.provider, model: m.model,
    })),
    tasks: team.tasks.map((t) => ({
      id: t.id, subject: t.subject, status: t.status, assignee: t.assignee,
      dependencies: t.dependencies, attempt: t.attempt, hasAttemptId: !!t.attemptId, output: t.output,
    })),
    unreadFor,
  };
}

export { TASK_TERMINAL, TASK_TRANSITIONS, canTransition } from "./types";
