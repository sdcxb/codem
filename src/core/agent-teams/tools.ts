/**
 * @codem/agent-teams — LLM 工具面（对标 EAC dsh-agent-teams tools.js 10 工具）
 *
 * 身份判定：ctx.sessionId === 队长的 captainSessionId 时为队长，可调用全部工具；
 * 成员（可续聊子 agent 会话）不可调用 CAPTAIN_ONLY_TOOLS。
 * 引擎为纯逻辑（engine.ts），本层负责：加载/保存团队、身份与授权、与
 * subagent runtime 桥接（add_member spawn 可续聊成员 / 唤醒投递），
 * 以及把引擎结果格式化为工具输出。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../llm/tools";
import { getLang } from "../i18n/lang";
import { AgentTeamsService, AgentTeamsServiceClass } from "../provider/agent-teams-service";
import { CAPTAIN, CAPTAIN_ONLY_TOOLS } from "./types";

const zh = () => getLang() === "zh";

function svc(): InstanceType<typeof AgentTeamsServiceClass> {
  return AgentTeamsService.getInstance();
}

function requireCaptain(ctx: ToolContext, teamId: string): boolean {
  const team = svc().get(teamId);
  return !!team && team.captainSessionId === ctx.sessionId;
}

/** 当前调用者身份：队长会话 → "captain"，否则为成员（用 sessionId 表示成员身份） */
function callerName(ctx: ToolContext, teamId: string): string {
  const team = svc().get(teamId);
  if (team && team.captainSessionId === ctx.sessionId) return CAPTAIN;
  // 成员：子 agent 会话 id 即成员 id；反查成员名（若无则退回 sessionId 前 8 位）
  const member = team?.members.find((m) => m.id === ctx.sessionId);
  return member ? member.name : ctx.sessionId;
}

/** 输出统一渲染：title + output 文本 */
function out(title: string, lines: string[]): ToolExecuteResult {
  return { title, output: lines.join("\n") };
}

// ========== 1. create ==========

export function createAgentTeamsCreateTool(): ToolDef {
  return {
    id: "agent_teams_create",
    description: zh()
      ? "创建多智能体团队。调用方成为队长。之后用 agent_teams_add_member 添加成员、agent_teams_create_task 拆解带依赖的任务。"
      : "Create a multi-agent team. The caller becomes the captain. Then use agent_teams_add_member to add members and agent_teams_create_task to break goals into dependency-aware tasks.",
    guidance: zh()
      ? "当用户要求'用团队/多名 agent 协作完成 X'时，先 create 团队再逐项派活。"
      : "When the user asks for a team of agents to collaborate on X, create the team first, then dispatch tasks.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: zh() ? "团队名称" : "Team name" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      const t = zh();
      const team = svc().create({ name: args.name as string, captainSessionId: ctx.sessionId });
      return out("agent_teams_create", [
        t ? `团队已创建: ${team.name} (${team.id})` : `Team created: ${team.name} (${team.id})`,
        t ? "下一步：agent_teams_add_member 添加成员" : "Next: agent_teams_add_member to add members",
      ]);
    },
  };
}

// ========== 2. add_member ==========

export function createAgentTeamsAddMemberTool(): ToolDef {
  return {
    id: "agent_teams_add_member",
    description: zh()
      ? "（队长）向团队添加一名可续聊成员（子 agent）。可指定 provider/model/reasoning_effort；缺省继承队长当前路由。"
      : "(captain) Add a continuable member (sub-agent) to the team. Optionally specify provider/model/reasoning_effort; defaults inherit the captain's route.",
    guidance: zh() ? "成员名要体现分工（研究员/工程师/测试），并给 role 说明。" : "Name members by role (researcher/engineer/qa) and describe the role.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "team id from agent_teams_create" },
        name: { type: "string", description: zh() ? "成员名（队内唯一）" : "Member name (unique)" },
        role: { type: "string", description: zh() ? "角色说明" : "Role description" },
        provider: { type: "string", description: zh() ? "可选：LLM provider id" : "Optional LLM provider id" },
        model: { type: "string", description: zh() ? "可选：模型 id" : "Optional model id" },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high"], description: zh() ? "可选：思考强度" : "Optional reasoning effort" },
      },
      required: ["team_id", "name"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      if (!requireCaptain(ctx, teamId)) throw new Error(t ? "仅队长可添加成员" : "Only the captain can add members");
      const { member } = await svc().addMember(teamId, {
        name: args.name as string,
        role: args.role as string | undefined,
        provider: args.provider as string | undefined,
        model: args.model as string | undefined,
        reasoningEffort: args.reasoning_effort as "low" | "medium" | "high" | undefined,
        parentSessionId: ctx.sessionId,
      });
      return out("agent_teams_add_member", [
        t ? `成员已加入: ${member.name} (${member.id})` : `Member added: ${member.name} (${member.id})`,
        member.role ? (t ? `角色: ${member.role}` : `Role: ${member.role}`) : "",
      ]);
    },
  };
}

// ========== 3. remove_member ==========

export function createAgentTeamsRemoveMemberTool(): ToolDef {
  return {
    id: "agent_teams_remove_member",
    description: zh() ? "（队长）移除成员：撤销其未完成任务回池，中断并停用其子会话。" : "(captain) Remove a member: unassign their open tasks, interrupt and retire the child session.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
        name: { type: "string", description: zh() ? "成员名" : "Member name" },
      },
      required: ["team_id", "name"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      if (!requireCaptain(ctx, teamId)) throw new Error(t ? "仅队长可移除成员" : "Only the captain can remove members");
      await svc().removeMember(teamId, args.name as string);
      return out("agent_teams_remove_member", [t ? `成员已移除: ${args.name}` : `Member removed: ${args.name}`]);
    },
  };
}

// ========== 4. create_task ==========

export function createAgentTeamsCreateTaskTool(): ToolDef {
  return {
    id: "agent_teams_create_task",
    description: zh()
      ? "（队长）创建任务。可指定 dependencies（前置任务 id，全部完成后才可领取）与 assignee（成员名或 captain；留空 = 共享池由空闲成员自动领取）。"
      : "(captain) Create a task. Optionally set dependencies (must all complete first) and assignee (member name or captain; empty = shared pool auto-claimed by idle members).",
    guidance: zh()
      ? "把目标拆成尽量并行、依赖清晰的小任务；dependencies 用已建任务的 t1/t2… id。"
      : "Break goals into parallel, dependency-clear tasks; reference prior ids like t1/t2 in dependencies.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
        subject: { type: "string", description: zh() ? "任务标题" : "Task subject" },
        description: { type: "string", description: zh() ? "细节（可选）" : "Details (optional)" },
        dependencies: { type: "array", items: { type: "string" }, description: zh() ? "前置任务 id 列表" : "Prerequisite task ids" },
        assignee: { type: "string", description: zh() ? "成员名或 captain（可选，留空共享池）" : "Member name or captain (optional)" },
      },
      required: ["team_id", "subject"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      if (!requireCaptain(ctx, teamId)) throw new Error(t ? "仅队长可创建任务" : "Only the captain can create tasks");
      const { task } = svc().createTask(teamId, {
        subject: args.subject as string,
        description: args.description as string | undefined,
        dependencies: (args.dependencies as string[]) ?? [],
        assignee: args.assignee as string | undefined,
      });
      return out(`agent_teams_create_task: ${task.id}`, [
        t ? `任务 ${task.id} 已创建: ${task.subject}` : `Task ${task.id} created: ${task.subject}`,
        task.dependencies.length > 0 ? (t ? `依赖: ${task.dependencies.join(", ")}` : `Dependencies: ${task.dependencies.join(", ")}`) : "",
        task.assignee ? (t ? `负责人: ${task.assignee}` : `Assignee: ${task.assignee}`) : (t ? "共享池（空闲成员自动领取）" : "Shared pool (auto-claimed)"),
      ]);
    },
  };
}

// ========== 5. reassign_task ==========

export function createAgentTeamsReassignTool(): ToolDef {
  return {
    id: "agent_teams_reassign_task",
    description: zh()
      ? "（队长）转派任务（重试/换人/队长接管）。撤销旧 attempt、中断原成员并开启新 attempt。"
      : "(captain) Reassign a task (retry / switch member / captain takeover). Revokes the old attempt and starts a new one.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
        task_id: { type: "string" },
        assignee: { type: "string", description: zh() ? "新负责人：成员名或 captain" : "New assignee: member name or captain" },
      },
      required: ["team_id", "task_id", "assignee"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      if (!requireCaptain(ctx, teamId)) throw new Error(t ? "仅队长可转派任务" : "Only the captain can reassign tasks");
      const r = svc().reassign(teamId, args.task_id as string, args.assignee as string);
      return out("agent_teams_reassign_task", [
        t ? `任务 ${r.task.id} 转派给 ${r.task.assignee}` : `Task ${r.task.id} reassigned to ${r.task.assignee}`,
        r.previousAssignee ? (t ? `原负责人: ${r.previousAssignee}` : `Previous: ${r.previousAssignee}`) : "",
      ]);
    },
  };
}

// ========== 6. claim_task ==========

export function createAgentTeamsClaimTool(): ToolDef {
  return {
    id: "agent_teams_claim_task",
    description: zh()
      ? "领取任务（队长可为他人代领；成员领取自己名下的任务）。依赖未完成/他人已认领会报错。领取返回 attempt_id，更新任务时必须携带。"
      : "Claim a task (captain may claim for others; members claim their own). Errors on unsatisfied deps or already-claimed. Returns attempt_id which must be passed to update_task.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
        task_id: { type: "string" },
        assignee: { type: "string", description: zh() ? "领取人（成员名；缺省 = 自己；仅队长可为他人代领）" : "Claimant (default self; captain may claim for others)" },
      },
      required: ["team_id", "task_id"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      const isCaptain = requireCaptain(ctx, teamId);
      const requested = (args.assignee as string | undefined) || "";
      const claimant = requested && isCaptain ? requested : callerName(ctx, teamId);
      const r = svc().claim(teamId, args.task_id as string, claimant);
      return out("agent_teams_claim_task", [
        t ? `已领取 ${r.taskId}（attempt ${r.attempt}）` : `Claimed ${r.taskId} (attempt ${r.attempt})`,
        t ? `attempt_id: ${r.attemptId} —— 更新任务必须携带` : `attempt_id: ${r.attemptId} — required for update_task`,
      ]);
    },
  };
}

// ========== 7. update_task ==========

export function createAgentTeamsUpdateTool(): ToolDef {
  return {
    id: "agent_teams_update_task",
    description: zh()
      ? "更新任务状态（in_progress / completed / failed / cancelled）。必须携带领取返回的 attempt_id；任务被转派后旧 attempt 会被拒绝（stale）。"
      : "Update task status (in_progress / completed / failed / cancelled). Must carry the attempt_id from claim; stale attempts are rejected after reassignment.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
        task_id: { type: "string" },
        status: { type: "string", enum: ["in_progress", "completed", "failed", "cancelled"] },
        output: { type: "string", description: zh() ? "结果摘要（完成/失败时）" : "Result summary (on completion/failure)" },
        attempt_id: { type: "string", description: zh() ? "领取时返回的 attempt_id（必填）" : "attempt_id from claim (required)" },
      },
      required: ["team_id", "task_id", "status", "attempt_id"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      const { task } = svc().update(teamId, args.task_id as string, {
        status: args.status as any,
        output: args.output as string | undefined,
        attemptId: args.attempt_id as string,
        by: callerName(ctx, teamId),
      });
      return out(`agent_teams_update_task: ${task.id}`, [
        t ? `任务 ${task.id} → ${task.status}` : `Task ${task.id} → ${task.status}`,
        task.output ? (t ? `输出: ${task.output}` : `Output: ${task.output}`) : "",
      ]);
    },
  };
}

// ========== 8. send_message ==========

export function createAgentTeamsSendMessageTool(): ToolDef {
  return {
    id: "agent_teams_send_message",
    description: zh()
      ? "给队长（to=captain）或某成员发送直达消息，无需队长中转。"
      : "Send a direct message to the captain (to=captain) or a member, no captain relay needed.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
        to: { type: "string", description: zh() ? "收件人：成员名或 captain" : "Recipient: member name or captain" },
        content: { type: "string", description: zh() ? "消息内容" : "Message content" },
      },
      required: ["team_id", "to", "content"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      const from = callerName(ctx, teamId);
      const r = await svc().sendMessage(teamId, args.to as string, args.content as string, from);
      return out("agent_teams_send_message", [
        t
          ? `消息已投递 ${from} → ${args.to}（${r.mode === "wake" ? "已唤醒成员" : r.mode === "live" ? "实时送达" : "已存入邮箱"}）`
          : `Message delivered ${from} → ${args.to} (${r.mode === "wake" ? "woke member" : r.mode === "live" ? "delivered live" : "queued in mailbox"})`,
      ]);
    },
  };
}

// ========== 9. status ==========

export function createAgentTeamsStatusTool(): ToolDef {
  return {
    id: "agent_teams_status",
    description: zh() ? "查看团队全貌：成员（角色/状态/模型）+ 任务（状态/负责人/attempt）+ 未读消息。" : "View team status: members (role/status/model) + tasks (status/assignee/attempt) + unread messages.",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
      },
      required: ["team_id"],
    },
    async execute(args) {
      const t = zh();
      const snap = svc().status(args.team_id as string);
      const lines: string[] = [];
      lines.push(t ? `# 团队 ${snap.name} (${snap.id})` : `# Team ${snap.name} (${snap.id})`);
      lines.push("");
      lines.push(t ? "## 成员" : "## Members");
      const statusLabel = (s: string) => (t ? ({ idle: "空闲", working: "工作中", removed: "已移除", absent: "离线" } as Record<string, string>)[s] ?? s : s);
      for (const m of snap.members) {
        const route = m.model ? ` [${m.provider}/${m.model}]` : "";
        lines.push(`- ${m.name} (${statusLabel(m.status)})${m.role ? `: ${m.role}` : ""}${route}`);
      }
      lines.push("");
      lines.push(t ? "## 任务" : "## Tasks");
      for (const task of snap.tasks) {
        const dep = task.dependencies.length ? ` (deps: ${task.dependencies.join(",")})` : "";
        lines.push(`- ${task.id} ${task.status} — ${task.subject}${task.assignee ? ` @${task.assignee}` : ""}${dep}`);
      }
      for (const [to, n] of Object.entries(snap.unreadFor)) {
        lines.push("");
        lines.push(t ? `未读消息 → ${to}: ${n} 条` : `Unread → ${to}: ${n}`);
      }
      return out("agent_teams_status", lines);
    },
  };
}

// ========== 10. delete ==========

export function createAgentTeamsDeleteTool(): ToolDef {
  return {
    id: "agent_teams_delete",
    description: zh() ? "（队长）删除并归档团队（撤销全部任务、标记成员移除、归档记录）。" : "(captain) Delete and archive the team (unassign tasks, retire members, archive record).",
    parameters: {
      type: "object",
      properties: {
        team_id: { type: "string" },
      },
      required: ["team_id"],
    },
    async execute(args, ctx) {
      const t = zh();
      const teamId = args.team_id as string;
      if (!requireCaptain(ctx, teamId)) throw new Error(t ? "仅队长可删除团队" : "Only the captain can delete the team");
      await svc().deleteTeam(teamId);
      return out("agent_teams_delete", [t ? "团队已删除并归档" : "Team deleted and archived"]);
    },
  };
}

/** 注册全部 10 个 agent_teams 工具（由 LLMEngine.setupDelegationTools 调用） */
export function registerAgentTeamsTools(register: (t: ToolDef) => void): void {
  register(createAgentTeamsCreateTool());
  register(createAgentTeamsAddMemberTool());
  register(createAgentTeamsRemoveMemberTool());
  register(createAgentTeamsCreateTaskTool());
  register(createAgentTeamsReassignTool());
  register(createAgentTeamsClaimTool());
  register(createAgentTeamsUpdateTool());
  register(createAgentTeamsSendMessageTool());
  register(createAgentTeamsStatusTool());
  register(createAgentTeamsDeleteTool());
}

export { CAPTAIN_ONLY_TOOLS };
