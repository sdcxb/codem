// @ts-nocheck
/**
 * @codem/agent-teams — 服务层（单例）
 *
 * 职责：
 * 1. 团队生命周期管理（create/get/delete）— 内存 Map + localStorage 持久化
 * 2. 成员 spawn：addMember 时经 SubagentRuntime.startContinuable 创建可续聊
 *    子 agent（成员 = 独立子会话，队长可 send_message 唤醒续聊）
 * 3. 邮箱投递：sendMessage → 直投（成员 live/idle）或持久化邮箱（回退）
 * 4. 调度 kick：任务图变更后尝试把就绪任务派给空闲成员（引擎原子领取 +
 *    投递失败精确回滚）
 * 5. 变更订阅（UI 活动面板刷新）
 *
 * 引擎为纯逻辑（engine.ts，全部可测）；本层收敛并发（单进程同步调用）。
 */

import {
  createTeam, addMember as engineAddMember, removeMember as engineRemoveMember,
  createTask, claimTask, updateTask, beginReassign, finishReassign,
  appendMailbox, claimMailbox, acknowledgeMailbox, releaseMailbox,
  unreadMailbox, snapshot, nextReadyTask, rollbackClaim,
  genId,
} from "../agent-teams/engine";
import type { AgentTeam, TeamSnapshot } from "../agent-teams/types";
import { CAPTAIN, TASK_TERMINAL } from "../agent-teams/types";
import { getSubagentRuntime } from "../subagent/index";

const STORE_KEY = "codem-agent-teams:v1";

export type AgentTeamsChangeListener = () => void;

interface SendResult {
  mode: "live" | "wake" | "mailbox";
}

export class AgentTeamsServiceClass {
  private teams = new Map<string, AgentTeam>();
  private listeners = new Set<AgentTeamsChangeListener>();

  constructor() {
    this.load();
  }

  // ========== 持久化 ==========

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const t of arr) this.teams.set(t.id, t);
    } catch { /* ignore corrupt */ }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...this.teams.values()]));
    } catch { /* storage full/unavailable */ }
  }

  // ========== 订阅 ==========

  subscribe(fn: AgentTeamsChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) { try { fn(); } catch { /* noop */ } }
  }

  // ========== 团队 CRUD ==========

  get(id: string): AgentTeam | undefined { return this.teams.get(id); }

  /** 队长当前活动团队（一人一队） */
  activeTeamOf(captainSessionId: string): AgentTeam | undefined {
    return [...this.teams.values()].find((t) => !t.archived && t.captainSessionId === captainSessionId);
  }

  create(input: { name: string; captainSessionId: string }): AgentTeam {
    // 队长同刻只带一个活动团队
    const existing = this.activeTeamOf(input.captainSessionId);
    if (existing) throw new Error(`captain already leads team "${existing.name}" (${existing.id}) — delete it first`);
    const team = createTeam(input);
    this.teams.set(team.id, team);
    this.persist();
    this.notify();
    return team;
  }

  deleteTeam(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    team.archived = true;
    this.persist();
    this.notify();
  }

  // ========== 成员 ==========

  /** 添加成员并 spawn 可续聊子 agent */
  async addMember(teamId: string, input: {
    name: string; role?: string; provider?: string; model?: string;
    reasoningEffort?: "low" | "medium" | "high";
    parentSessionId: string;
  }) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);

    // 1. 引擎加成员（名唯一校验）
    const { member } = engineAddMember(team, {
      id: `member-pending-${genId("m")}`,
      name: input.name,
      role: input.role,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });

    // 2. 尽量 spawn 可续聊子 agent（成员 = 独立子会话）；失败则成员标记 absent
    const rt = getSubagentRuntime();
    if (!rt) {
      // 无 subagent runtime（测试/未初始化）：成员不可唤醒 → absent（kick 跳过）
      member.status = "absent";
    } else {
      try {
        const started = await rt.startContinuable({
          provider: "spawn",
          label: `team:${input.name}`,
          request: {
            prompt: this.memberWelcomePrompt(team, input),
            parentSessionId: input.parentSessionId,
            cwd: this.cwdOf(input.parentSessionId),
            agentId: "general",
          },
          signal: new AbortController().signal,
        });
        member.id = started.childId; // 成员 = 持久子会话 id
        member.status = "idle";
      } catch (e) {
        console.warn("[agent-teams] member spawn failed (member stays 'absent'):", e);
        member.status = "absent";
      }
    }

    this.persist();
    this.notify();
    return { member };
  }

  /** 移除成员：撤销未完成任务 → 标记 removed（中断子会话由上层 subagent 体系处理） */
  removeMember(teamId: string, name: string) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const { removed } = engineRemoveMember(team, name);
    this.persist();
    this.notify();
    return { removed };
  }

  private memberWelcomePrompt(team: AgentTeam, input: { name: string; role?: string }): string {
    const zh = true; // 成员 prompt 跟随当前语言 —— 用中性双语更稳
    return [
      `You are a member "${input.name}" of the team "${team.name}"${input.role ? `, role: ${input.role}` : ""}.`,
      "You collaborate via the agent_teams_* tools: claim tasks with agent_teams_claim_task (carry the returned attempt_id), update with agent_teams_update_task, report to the captain or teammates with agent_teams_send_message, and check the board with agent_teams_status. Never fabricate task states — only update tasks you actually claimed.",
      "When you finish a task, call agent_teams_update_task with status=completed and an output summary.",
    ].join("\n\n");
  }

  private cwdOf(_sessionId: string): string {
    try {
      // ESM: dynamic import（此路径仅供 spawn 成员时取项目 cwd，失败回退 process.cwd）
      const { useProjectStore } = require("../store");
      return useProjectStore.getState().currentProject?.path || "";
    } catch {
      return "";
    }
  }

  // ========== 任务 ==========

  createTask(teamId: string, input: { subject: string; description?: string; dependencies?: string[]; assignee?: string }) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const { task } = createTask(team, input);
    this.persist();
    this.notify();
    this.kick(teamId);
    return { task };
  }

  claim(teamId: string, taskId: string, by: string) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const r = claimTask(team, taskId, by);
    this.persist();
    this.notify();
    return { teamId, taskId, attemptId: r.attemptId, attempt: r.attempt };
  }

  update(teamId: string, taskId: string, input: { status: any; output?: string; attemptId?: string; by: string }) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const { task } = updateTask(team, taskId, input);
    // 任务进入终态 → 释放该成员（否则成员会永久停在 working，调度器再也不派活，
    // 依赖成员状态的监控视图也会一直显示「工作中」）
    this.releaseAssigneeIfIdle(team, task.assignee);
    this.persist();
    this.notify();
    this.kick(teamId);
    return { teamId, taskId, task };
  }

  /** 转派：撤销旧 attempt → 静默期 → 对新 assignee 开新 attempt */
  reassign(teamId: string, taskId: string, newAssignee: string) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const r = beginReassign(team, taskId, newAssignee);
    // 旧负责人不再持有该任务 → 若无其它在办任务则释放为 idle
    this.releaseAssigneeIfIdle(team, r.previousAssignee);
    // 若接管者就是队长本人，立即结束静默（无成员需要中断）
    if (newAssignee === CAPTAIN) {
      finishReassign(team, taskId, CAPTAIN);
    }
    this.persist();
    this.notify();
    this.kick(teamId);
    return r;
  }

  /**
   * 释放成员：当该成员名下已无非终态任务且当前状态为 working 时置回 idle。
   * 队长（"captain"）与非成员标识不处理。
   */
  private releaseAssigneeIfIdle(team: AgentTeam, assignee: string | undefined): void {
    if (!assignee || assignee === CAPTAIN) return;
    const member = team.members.find((m) => m.name === assignee);
    if (!member || member.status !== "working") return;
    const stillBusy = team.tasks.some(
      (t) => t.assignee === assignee && !TASK_TERMINAL.has(t.status),
    );
    if (stillBusy) return;
    member.status = "idle";
  }

  // ========== 邮箱 / 消息 ==========

  /** 成员或队长发消息：先入邮箱，尽力直投（live/wake），失败留在邮箱等调度重投 */
  async sendMessage(teamId: string, to: string, content: string, from: string): Promise<{ mode: "live" | "wake" | "mailbox" }> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const msg = appendMailbox(team, { to, from, content });

    const delivered = await this.deliverMailbox(teamId, to);
    this.persist();
    this.notify();
    return { mode: delivered };
  }

  /** 尝试投递某收件人邮箱中未投递消息。直投成功才 ack；失败 release（下次调度重投）。 */
  private async deliverMailbox(teamId: string, to: string): Promise<"live" | "wake" | "mailbox"> {
    const team = this.teams.get(teamId);
    if (!team) return "mailbox";
    const pending = unreadMailbox(team, to);
    if (pending.length === 0) return "live";

    // 队长收件：通过队长会话 inbox 机制通知（简化：ack 即视为已投递，UI 面板可见）
    if (to === CAPTAIN) {
      acknowledgeMailbox(team, pending.map((m) => m.id));
      return "live";
    }

    // 成员收件：若成员 live 且可唤醒 → followup；否则留邮箱
    const member = team.members.find((m) => m.name === to);
    if (!member || member.status === "removed") {
      // 无此成员：退回（不投递，留在邮箱供队长查看）
      return "mailbox";
    }
    claimMailbox(team, pending.map((m) => m.id));
    try {
      const rt = getSubagentRuntime();
      if (rt && member.status !== "absent") {
        const text = pending.map((m) => `[${m.from}] ${m.content}`).join("\n\n");
        await rt.followup(member.id, text, { signal: new AbortController().signal });
        acknowledgeMailbox(team, pending.map((m) => m.id));
        return "wake";
      }
    } catch (e) {
      console.warn("[agent-teams] member wake failed, leaving in mailbox:", e);
    }
    releaseMailbox(team, pending.map((m) => m.id));
    return "mailbox";
  }

  // ========== 调度 ==========

  /**
   * 任务图变更后尝试派活：找空闲成员 + 就绪任务，引擎原子领取 → 唤醒。
   * 简化（单进程同步语义）：对每个非 removed 成员，若有就绪任务则领取并唤醒。
   */
  private kick(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team || team.archived) return;
    for (const member of team.members) {
      if (member.status === "removed" || member.status === "working" || member.status === "absent") continue;
      const task = nextReadyTask(team, member.name);
      if (!task) continue;
      try {
        const r = claimTask(team, task.id, member.name);
        member.status = "working";
        // 异步唤醒（不阻塞工具返回）
        const rt = getSubagentRuntime();
        if (rt && member.status !== "absent") {
          const assignment = `[任务分配] ${task.id}: ${task.subject}${task.description ? "\n" + task.description : ""}\n` +
            `用 agent_teams_claim_task 领取（会返回同一 attempt_id ${r.attemptId}），完成后 agent_teams_update_task(status=completed, attempt_id=…)。`;
          rt.followup(member.id, assignment, { signal: new AbortController().signal }).catch(() => {
            // 投递失败 → 精确回滚
            rollbackClaim(team, task.id, r.attemptId, task.assignee);
            member.status = "idle";
            this.persist();
            this.notify();
          });
        } else {
          // 无 runtime（测试/冷态）：回滚，成员留 idle
          rollbackClaim(team, task.id, r.attemptId);
          member.status = "idle";
        }
      } catch {
        /* claim race — next member */
      }
    }
    this.persist();
    this.notify();
  }

  // ========== 查询 ==========

  status(teamId: string): TeamSnapshot {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    return snapshot(team);
  }

  listAll(): AgentTeam[] {
    return [...this.teams.values()].filter((t) => !t.archived);
  }
}

let svcInstance: AgentTeamsServiceClass | null = null;

export const AgentTeamsService = {
  getInstance(): AgentTeamsServiceClass {
    if (!svcInstance) svcInstance = new AgentTeamsServiceClass();
    return svcInstance;
  },
  /** 测试用重置 */
  _reset(): void {
    try { localStorage.removeItem(STORE_KEY); } catch { /* noop */ }
    svcInstance = null;
  },
};
