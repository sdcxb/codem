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
  TASK_EVIDENCE_KINDS,
  type DocSyncCheck,
  type TaskArtifact,
  type TaskAttemptRecord,
  type TaskCompletionBlock,
  type TaskEvidence,
  type TaskEvidenceInput,
  type TaskEvidenceKind,
  type TaskRollbackRecord,
  type TaskVerification,
} from "./types";
import { evaluateTaskCompletion } from "./completion";

// ========== 小工具 ==========

export function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function genAttemptId(): string {
  return crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

// ========== C10：工件 / 尝试 / 证据账本（内部小工具） ==========

/**
 * 旧任务（本轮之前创建 / 测试里手工 push 的）没有 C10 字段。
 * 每次读写前补齐数组与默认完成条件 —— 不要求调用方记忆迁移。
 */
function ensureLedger(task: TeamTask): void {
  if (!Array.isArray(task.attempts)) task.attempts = [];
  if (!Array.isArray(task.artifacts)) task.artifacts = [];
  if (!Array.isArray(task.rollbacks)) task.rollbacks = [];
  if (!Array.isArray(task.evidence)) task.evidence = [];
  if (!task.completion) {
    task.completion = { requiredEvidence: [...TASK_EVIDENCE_KINDS], requireVerification: true };
  }
}

function copyArtifacts(artifacts: TaskArtifact[]): TaskArtifact[] {
  return artifacts.map((artifact) => ({ ...artifact }));
}

function copyEvidence(evidence: TaskEvidence[]): TaskEvidence[] {
  return evidence.map((item) => ({ ...item }));
}

/** 登记/更新一个共享工件；同 kind+ref 再次登记 ⇒ revision+1（回滚按版本恢复）。 */
function upsertArtifact(
  task: TeamTask,
  input: { kind: TaskEvidenceKind; ref: string },
  by: string,
  now: number,
): TaskArtifact {
  ensureLedger(task);
  const ref = input.ref.trim();
  const existing = task.artifacts!.find((artifact) => artifact.kind === input.kind && artifact.ref === ref);
  if (existing) {
    existing.revision += 1;
    existing.updatedAt = now;
    existing.updatedBy = by;
    return existing;
  }
  const artifact: TaskArtifact = {
    id: `${input.kind}:${ref}`,
    kind: input.kind,
    ref,
    revision: 1,
    updatedAt: now,
    updatedBy: by,
  };
  task.artifacts!.push(artifact);
  return artifact;
}

/**
 * 登记证据（幂等）：
 * - 同一 kind+ref+status 重复提交 ⇒ 不重复追加、不涨工件版本（工具重试安全）；
 * - 同一 kind+ref 但状态变化（如测试 fail → pass）⇒ 更新并让工件版本 +1；
 * - 新证据 ⇒ 追加证据 + 登记工件。
 */
function applyEvidence(
  task: TeamTask,
  inputs: TaskEvidenceInput[] | undefined,
  by: string,
  now: number,
): TaskEvidence[] {
  ensureLedger(task);
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const written: TaskEvidence[] = [];
  for (const raw of inputs) {
    if (!raw || typeof raw !== "object") throw new Error("evidence 条目必须是对象");
    const kind = raw.kind;
    if (!TASK_EVIDENCE_KINDS.includes(kind)) {
      throw new Error(`invalid evidence kind "${String(kind)}"（只接受 code/doc/test/reference）`);
    }
    const ref = typeof raw.ref === "string" ? raw.ref.trim() : "";
    if (!ref) throw new Error("evidence.ref 不能为空（必须是可回溯的坐标）");
    const status = raw.status === "pass" || raw.status === "fail" ? raw.status : undefined;
    if (kind === "test" && status === undefined) {
      throw new Error("test 证据必须带 status=pass|fail（未执行的测试不能当完成依据）");
    }
    const existing = task.evidence!.find(
      (item) => item.kind === kind && item.ref === ref,
    );
    if (existing) {
      const same = existing.status === status && existing.summary === raw.summary;
      if (same) {
        written.push(existing);
        continue;
      }
      existing.status = status ?? existing.status;
      if (raw.summary !== undefined) existing.summary = raw.summary;
      existing.addedAt = now;
      existing.addedBy = by;
      written.push(existing);
      upsertArtifact(task, { kind, ref }, by, now);
      continue;
    }
    const item: TaskEvidence = {
      kind,
      ref,
      ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
      ...(status !== undefined ? { status } : {}),
      addedAt: now,
      addedBy: by,
    };
    task.evidence!.push(item);
    written.push(item);
    upsertArtifact(task, { kind, ref }, by, now);
  }
  return written;
}

function activeAttemptOf(task: TeamTask): TaskAttemptRecord | undefined {
  ensureLedger(task);
  const attemptId = task.attemptId;
  if (!attemptId) return undefined;
  return [...task.attempts!].reverse().find((attempt) => attempt.attemptId === attemptId);
}

function endAttempt(
  task: TeamTask,
  attemptId: string | undefined,
  status: TaskAttemptRecord["status"],
  output: string | undefined,
  now: number,
): void {
  if (!attemptId) return;
  ensureLedger(task);
  const attempt = [...task.attempts!].reverse().find((item) => item.attemptId === attemptId);
  if (!attempt) return;
  attempt.status = status;
  attempt.endedAt = now;
  if (output !== undefined) attempt.output = output;
}

/** 更新任务时的可选依赖（文档同步谓词由服务层/测试注入） */
export interface TaskUpdateOptions {
  docSyncCheck?: DocSyncCheck;
  /** 测试注入固定时钟；生产不传 = Date.now() */
  now?: number;
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
  provider?: string; model?: string; reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  /** C10：验收口径（代码/文档/测试/引用 + Verifier） */
  acceptance?: string;
  /** C10：声明必须齐备的证据类别；缺省 = 四类全要 */
  requiredEvidence?: TaskEvidenceKind[];
  /** C10：是否要求独立 Verifier（缺省 true） */
  requireVerification?: boolean;
  /**
   * Bot peer（25:656）：Task 就是 work。给了 `peer` 的任务由 `message_bot` 的 runner
   * 独占执行（`nextReadyTask` 会跳过它），完成条件也不是 C10 四类证据，而是
   * 「下游交回了结果」—— 结算走 `settlePeerTask`。
   */
  peer?: {
    requestId: string;
    parentTaskId?: string;
    sourceBotId: string;
    targetBotId: string;
    deadlineAt?: number;
  };
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
  const required = input.requiredEvidence ?? [...TASK_EVIDENCE_KINDS];
  for (const kind of required) {
    if (!TASK_EVIDENCE_KINDS.includes(kind)) {
      throw new Error(`invalid required_evidence "${String(kind)}"（只接受 code/doc/test/reference）`);
    }
  }
  const peer = normalizePeerInput(team, input.peer);
  const id = `t${++team.taskSeq}`;
  const task: TeamTask = {
    id,
    subject: input.subject,
    description: input.description,
    acceptance: input.acceptance,
    status: "pending",
    assignee: input.assignee,
    dependencies: input.dependencies ?? [],
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    attempts: [],
    artifacts: [],
    rollbacks: [],
    evidence: [],
    completion: {
      requiredEvidence: [...new Set(required)],
      requireVerification: input.requireVerification !== false,
    },
    ...(peer ?? {}),
  };
  team.tasks.push(task);
  touch(team);
  return { team, task };
}

/**
 * 归一/校验 peer 输入（`createTask` 的 peer 分支）。
 *
 * requestId 在**同一团队内唯一**是幂等判据的物理前提：不在这里拦，两次调用就会
 * 造出两条同 requestId 的任务，「同 requestId 同内容返回原任务」不再成立。
 */
function normalizePeerInput(
  team: AgentTeam,
  peer: {
    requestId: string;
    parentTaskId?: string;
    sourceBotId: string;
    targetBotId: string;
    deadlineAt?: number;
  } | undefined,
): Pick<TeamTask, "requestId" | "parentTaskId" | "sourceBotId" | "targetBotId" | "deadlineAt"> | undefined {
  if (!peer) return undefined;
  const requestId = typeof peer.requestId === "string" ? peer.requestId.trim() : "";
  const sourceBotId = typeof peer.sourceBotId === "string" ? peer.sourceBotId.trim() : "";
  const targetBotId = typeof peer.targetBotId === "string" ? peer.targetBotId.trim() : "";
  if (requestId === "" || sourceBotId === "" || targetBotId === "") {
    throw new Error("peer 任务必须带非空的 requestId / sourceBotId / targetBotId");
  }
  const duplicate = team.tasks.find((item) => item.requestId === requestId);
  if (duplicate) {
    throw new Error(`peer requestId "${requestId}" 已存在（task ${duplicate.id}）：同一 requestId 只允许一条任务`);
  }
  const parentTaskId = typeof peer.parentTaskId === "string" ? peer.parentTaskId.trim() : "";
  if (parentTaskId !== "" && !team.tasks.some((item) => item.id === parentTaskId)) {
    throw new Error(`peer parentTaskId "${parentTaskId}" does not exist`);
  }
  return {
    requestId,
    sourceBotId,
    targetBotId,
    ...(parentTaskId !== "" ? { parentTaskId } : {}),
    ...(typeof peer.deadlineAt === "number" && Number.isFinite(peer.deadlineAt) ? { deadlineAt: peer.deadlineAt } : {}),
  };
}

/**
 * 按 id 取任务（**仅供本模块内部使用**）。
 *
 * 第 159 轮：knip 棘轮报"未使用导出 +1"，样例就是这个函数 —— 它只在本文件里被调（153/181/213/…），
 * 没有任何外部模块 import 它。**门禁是对的**：一个只在本文件用的函数不该占着导出面
 * （导出面越大，别人越容易绕过 `claimTask`/`updateTask` 这些带守恒检查的入口直接改任务状态）。
 * 所以去掉 `export`，而不是把它写进 ignore。
 */
function getTask(team: AgentTeam, id: string): TeamTask {
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
    /**
     * peer 任务（`requestId` 有值）由 `message_bot` 的 runner **独占**执行。
     *
     * 为什么调度器必须跳过：`kick()` 会在 `createTask` 里同步跑一次，若它把 peer 任务
     * 领走并唤醒成员，同一件活就会跑两遍（成员唤醒 + runner），而 runner 随后
     * `claimTask` 又会覆盖 attempt 令牌 —— 结算时旧令牌被拒，结果永远交不回。
     */
    t.requestId === undefined &&
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
  ensureLedger(task);
  // 幂等命中
  if ((task.status === "claimed" || task.status === "in_progress") && task.assignee === by) {
    if (!task.claim && task.attemptId) {
      task.claim = { by, attempt: task.attempt, attemptId: task.attemptId, claimedAt: Date.now() };
    }
    return { team, attemptId: task.attemptId!, attempt: task.attempt };
  }
  if (TASK_TERMINAL.has(task.status)) throw new Error(`task "${taskId}" already ${task.status}`);
  if (task.reassigning) throw new Error(`task "${taskId}" is being reassigned; try later`);
  if (task.assignee && task.assignee !== by) throw new Error(`task "${taskId}" is assigned to "${task.assignee}"`);
  if (!depsSatisfied(team, task)) {
    const missing = task.dependencies.filter((d) => team.tasks.find((t) => t.id === d)?.status !== "completed");
    throw new Error(`task "${taskId}" has unsatisfied dependencies: ${missing.join(", ")}`);
  }
  const now = Date.now();
  /**
   * 领取瞬间快照上一版工件/证据：这是 `rollbackTask` 的恢复目标。
   * 快照必须发生在任何本次修改之前 —— 否则回滚会滚到一个中间态。
   */
  task.attempt = task.attempt + 1;
  task.attemptId = genAttemptId();
  task.assignee = by;
  task.status = "claimed";
  task.claim = { by, attempt: task.attempt, attemptId: task.attemptId, claimedAt: now };
  task.blockedReason = undefined;
  task.attempts!.push({
    attempt: task.attempt,
    attemptId: task.attemptId,
    by,
    startedAt: now,
    status: "claimed",
    artifactSnapshot: copyArtifacts(task.artifacts!),
    evidenceSnapshot: copyEvidence(task.evidence!),
  });
  task.updatedAt = now;
  touch(team);
  return { team, attemptId: task.attemptId, attempt: task.attempt };
}

/**
 * 更新任务（对标 EAC update_task）：成员必须带当前 attemptId（stale 拒绝）；
 * 终态幂等（重复 completed 带相同 attempt 返回成功）。写完 kickTeam 由调用方做。
 *
 * C10：`completed` 不是"把状态字段改一下"，而是一道**完成门禁** ——
 * 代码/文档/测试/引用四类证据 + 独立 Verifier + 文档同步，缺任一都返回 `blocked`
 * （任务状态保持原样，`blockedReason` 写清楚），绝不静默标完成。
 */
export function updateTask(team: AgentTeam, taskId: string, input: {
  status: TeamTaskStatus; output?: string; attemptId?: string; by: string;
  /** C10：随本次更新登记证据（工具重试幂等） */
  evidence?: TaskEvidenceInput[];
}, options?: TaskUpdateOptions): { team: AgentTeam; task: TeamTask; blocked?: TaskCompletionBlock } {
  const task = getTask(team, taskId);
  ensureLedger(task);
  const now = options?.now ?? Date.now();
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

  applyEvidence(task, input.evidence, input.by, now);

  if (input.status === "completed") {
    const evaluation = evaluateTaskCompletion(task, options?.docSyncCheck);
    if (!evaluation.ok) {
      const block: TaskCompletionBlock = evaluation.block ?? { missing: evaluation.missing, reasons: evaluation.reasons };
      task.blockedReason = block.reasons.join("；");
      task.updatedAt = now;
      touch(team);
      return { team, task, blocked: block };
    }
    task.blockedReason = undefined;
  }

  task.status = input.status;
  if (input.output) task.output = input.output;
  task.updatedAt = now;
  if (input.status === "in_progress") {
    endAttempt(task, task.attemptId, "in_progress", undefined, now);
  }
  if (input.status === "pending") {
    // 回池（不是终态）：结束当前尝试、清执行权，下一轮重新领取会开新代
    endAttempt(task, task.attemptId, "cancelled", input.output, now);
    task.attemptId = undefined;
    task.claim = undefined;
  }
  if (input.status === "failed" || input.status === "cancelled") {
    endAttempt(task, task.attemptId, input.status, input.output, now);
  }
  if (TASK_TERMINAL.has(input.status)) {
    // 进入终态：清令牌与交接标记
    if (input.status === "completed") {
      endAttempt(task, task.attemptId, "completed", input.output, now);
    }
    task.attemptId = undefined;
    task.reassigning = false;
    task.handoffId = undefined;
  }
  touch(team);
  return { team, task };
}

/**
 * peer 任务结算（25:656 / 25:659）：把下游交回的结果/失败写进 **TeamTask.output / status**。
 *
 * ## 为什么不是 `updateTask`
 *
 * `updateTask` 的 `completed` 是 **C10 完成门禁**（四类证据 + 独立 Verifier + 文档同步）。
 * peer 任务的完成条件是另一件事：**下游 runner 交回了结果**（结果同时落 mailbox 结算）。
 * 把它硬塞进 C10 门禁只会逼着调用方编造证据；因此这里给一条**只对 peer 任务开放**的
 * 结算路径，并用 `requestId` 做闸门（没有 requestId 的任务走不进来，C10 门禁不受影响）。
 *
 * ## 幂等（「超时只结算一次」）
 *
 * 任务已进入终态 ⇒ 直接返回 `settled: false`，**不再写 output、也不再产生第二条结算消息**。
 * 这是持久事实（状态字段），不是进程内 Set —— 重启后仍然成立。
 */
export function settlePeerTask(team: AgentTeam, taskId: string, input: {
  status: "completed" | "failed";
  output: string;
  by: string;
  attemptId?: string;
  now?: number;
}): { team: AgentTeam; task: TeamTask; settled: boolean } {
  const task = getTask(team, taskId);
  if (typeof task.requestId !== "string" || task.requestId.trim() === "") {
    throw new Error(`task "${taskId}" 没有 requestId：peer 结算只认 Bot 派活出来的任务（C10 任务请走 updateTask）`);
  }
  const now = input.now ?? Date.now();
  if (TASK_TERMINAL.has(task.status)) {
    // 已经结算过（完成/失败/超时）：不再写第二次，也不再产生第二条结算消息
    return { team, task, settled: false };
  }
  /**
   * `claimed` 直接完成是 peer 任务的常态（claim 之后马上跑完，没有独立的 in_progress 阶段）。
   * 状态机里 `claimed → completed` 不是一条边（成员手动推进必须先 in_progress），
   * 这里**走两步合法迁移**而不是放宽全局迁移表：claimed → in_progress → completed。
   */
  if (task.status === "claimed" && input.status === "completed") {
    task.status = "in_progress";
  }
  if (!canTransition(task.status, input.status)) {
    throw new Error(`invalid peer settlement ${task.status} → ${input.status} for task "${taskId}"`);
  }
  if (task.attemptId && input.attemptId && task.attemptId !== input.attemptId) {
    throw new Error(`stale attempt for task "${taskId}": 任务已被转派，不要让旧 runner 结算别人的 attempt`);
  }
  ensureLedger(task);
  task.status = input.status;
  task.output = input.output;
  task.updatedAt = now;
  endAttempt(task, task.attemptId, input.status === "completed" ? "completed" : "failed", input.output, now);
  task.attemptId = undefined;
  task.reassigning = false;
  task.handoffId = undefined;
  task.blockedReason = undefined;
  touch(team);
  return { team, task, settled: true };
}

/**
 * 回滚任务（C10）：把**工件与证据**恢复到本次尝试领取时的上一版，并把任务放回共享池。
 *
 * 语义边界：
 * - 只恢复"领取时快照"里的那一版，不理解哪一次修改是坏的（那是 Conductor 的判断）；
 * - 回滚会作废当前 attempt（`rolled_back`），下一次领取 attempt++；
 * - `completed` 任务也允许回滚（用户/Conductor 发现完成后才暴露的问题时，必须能退回去）。
 *   回滚后任务回到 `pending`，重新走 claim → Verifier → completed 全流程。
 */
export function rollbackTask(team: AgentTeam, taskId: string, input: {
  by: string; reason: string; attemptId?: string;
}, options?: { now?: number }): { team: AgentTeam; task: TeamTask; rollback: TaskRollbackRecord } {
  const task = getTask(team, taskId);
  ensureLedger(task);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Error("rollback 需要写明原因（不能静默回滚）");
  if (input.attemptId && task.attemptId && input.attemptId !== task.attemptId) {
    throw new Error(`stale attempt for rollback of task "${taskId}"`);
  }
  const attempts = task.attempts!;
  const target = [...attempts].reverse().find((attempt) =>
    input.attemptId ? attempt.attemptId === input.attemptId : true,
  );
  if (!target) throw new Error(`task "${taskId}" has no attempt to roll back`);
  const now = options?.now ?? Date.now();
  const fromStatus = task.status;
  const currentArtifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const restoredArtifacts = target.artifactSnapshot.map((snapshot) => {
    const current = currentArtifacts.find((artifact) => artifact.id === snapshot.id);
    return { id: snapshot.id, fromRevision: current?.revision ?? 0, toRevision: snapshot.revision };
  });
  task.artifacts = copyArtifacts(target.artifactSnapshot);
  task.evidence = copyEvidence(target.evidenceSnapshot);
  // 工件/证据已回退 ⇒ 之前的验证与文档同步结论作废（必须重新验证）
  task.verification = undefined;
  task.docSync = undefined;
  task.blockedReason = undefined;
  task.status = "pending";
  task.assignee = undefined;
  task.reassigning = false;
  task.handoffId = undefined;
  task.attemptId = undefined;
  task.claim = undefined;
  target.status = "rolled_back";
  target.endedAt = now;
  const record: TaskRollbackRecord = {
    at: now,
    by: input.by,
    reason,
    fromStatus,
    toStatus: "pending",
    attempt: target.attempt,
    restoredArtifacts,
  };
  task.rollbacks!.push(record);
  task.updatedAt = now;
  touch(team);
  return { team, task, rollback: record };
}

/**
 * 转派 / 队长接管（对标 EAC reassign_task）：
 * 撤销旧 attempt → 记 handoff → 置 reassigning 静默期（由服务层中断旧成员并等
 * 静默后，对新 assignee 重新 beginTaskAttempt）。本函数负责状态侧。
 */
export function beginReassign(team: AgentTeam, taskId: string, newAssignee: string): { team: AgentTeam; task: TeamTask; previousAssignee?: string } {
  const task = getTask(team, taskId);
  ensureLedger(task);
  if (TASK_TERMINAL.has(task.status)) throw new Error(`task "${taskId}" already ${task.status} — cannot reassign`);
  const previousAssignee = task.assignee;
  // 旧 attempt 作废（取消而不是回滚：工件保留给新负责人继续做）
  endAttempt(task, task.attemptId, "cancelled", undefined, Date.now());
  task.claim = undefined;
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

/**
 * 取消静默期（不领取）：回到共享池（可选保留目标 assignee）。
 *
 * 用途：`finishReassign` 失败（例如依赖未满足）时，任务**不能**继续挂着
 * `reassigning: true` —— `nextReadyTask` 会永远跳过它、`claimTask` 会一直抛
 * "is being reassigned"，任务就此永久卡死。
 */
export function cancelReassign(team: AgentTeam, taskId: string, keepAssignee?: string): { team: AgentTeam; task: TeamTask } {
  const task = getTask(team, taskId);
  ensureLedger(task);
  task.reassigning = false;
  task.handoffId = undefined;
  task.status = "pending";
  task.attemptId = undefined;
  task.claim = undefined;
  task.assignee = keepAssignee;
  task.updatedAt = Date.now();
  touch(team);
  return { team, task };
}

/** 回滚一次领取（投递失败时，仅当 attemptId 仍是我们开的） */
export function rollbackClaim(team: AgentTeam, taskId: string, attemptId: string, toAssignee?: string): { team: AgentTeam; task: TeamTask } {
  const task = getTask(team, taskId);
  ensureLedger(task);
  if (task.attemptId !== attemptId) return { team, task }; // 已被并发转派，不动
  endAttempt(task, attemptId, "rolled_back", undefined, Date.now());
  task.status = "pending";
  task.assignee = toAssignee;
  task.attemptId = undefined;
  task.claim = undefined;
  task.reassigning = false;
  task.handoffId = undefined;
  task.updatedAt = Date.now();
  touch(team);
  return { team, task };
}

function invalidateTask(team: AgentTeam, task: TeamTask, toAssignee?: string): void {
  ensureLedger(task);
  endAttempt(task, task.attemptId, "cancelled", undefined, Date.now());
  task.status = "pending";
  task.assignee = toAssignee;
  task.attemptId = undefined;
  task.claim = undefined;
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
  tasks: Array<{
    id: string; subject: string; status: TeamTaskStatus; assignee?: string; dependencies: string[];
    attempt: number; hasAttemptId: boolean; output?: string;
    // ===== C10：共享任务图/工件 =====
    acceptance?: string;
    claimBy?: string;
    attempts: number;
    rollbacks: number;
    artifacts: Array<{ kind: TaskEvidenceKind; ref: string; revision: number }>;
    evidenceKinds: TaskEvidenceKind[];
    verified: boolean;
    blockedReason?: string;
    // ===== Bot peer：等待关系从 TeamTask 读（25:656 / 25:659） =====
    requestId?: string;
    parentTaskId?: string;
    sourceBotId?: string;
    targetBotId?: string;
    deadlineAt?: number;
  }>;
  unreadFor: Record<string, number>; // 收件人 → 未读条数
  /**
   * 运行时告警（不持久化）：重启对账结果、唤醒失败、无法唤醒的成员等。
   * 这些是"用户/模型必须知道否则会误判"的事实，不能只写在 console 里。
   */
  alerts?: string[];
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
      acceptance: t.acceptance,
      claimBy: t.claim?.by,
      attempts: Array.isArray(t.attempts) ? t.attempts.length : 0,
      rollbacks: Array.isArray(t.rollbacks) ? t.rollbacks.length : 0,
      artifacts: (Array.isArray(t.artifacts) ? t.artifacts : []).map((a) => ({ kind: a.kind, ref: a.ref, revision: a.revision })),
      evidenceKinds: [...new Set((Array.isArray(t.evidence) ? t.evidence : []).map((e) => e.kind))],
      verified: t.verification?.verdict === "pass",
      blockedReason: t.blockedReason,
      requestId: t.requestId,
      parentTaskId: t.parentTaskId,
      sourceBotId: t.sourceBotId,
      targetBotId: t.targetBotId,
      deadlineAt: t.deadlineAt,
    })),
    unreadFor,
  };
}

