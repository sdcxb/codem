/**
 * Squad Tools — LLM 工具注册（团队模板入口）
 *
 * 【B 深合并（2026-09-07）】Squad 记录 = 「团队模板」；运行时执行统一由
 * agent-teams 承担。三个工具语义升级（id/参数兼容，行为指向新能力）：
 * 1. squad_list   — 列出当前项目的团队模板（含角色）
 * 2. squad_dispatch — 按模板创建 agent-teams 运行时团队并派发任务
 *                     （确定性调度：成员按角色领取；替代旧的"开 Leader
 *                       会话自行编排"的事件派发路径）
 * 3. squad_status — 模板信息 + 从该模板实例化的运行时团队状态（可传 team_id）
 *
 * 注册方式：在 LLMEngine.setupDelegationTools() 中调用
 */

import type { ToolDef } from "../llm/tools";
import { getSquadManager } from "./squad";
import { useProjectStore } from "../store";
import { getLang } from "../i18n/lang";

// ========== 1. squad_list ==========

export function createSquadListTool(): ToolDef {
  return {
    id: "squad_list",
  guidance: "Use squad_list to see all available team templates (squads) and their roles.",
    description:
      "List all team templates (squads) in the current project. Returns each template's name, captain role, member roles, and instructions. " +
      "Templates are blueprints: squad_dispatch instantiates a template into a running agent-teams team.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_args, _ctx) {
      const zh = getLang() === "zh";
      const mgr = getSquadManager();
      const projectId = useProjectStore.getState().currentProject?.id;
      const squads = mgr.listSquads(projectId);

      if (squads.length === 0) {
        return {
          title: "squad_list",
          output: zh ? "当前项目暂无团队模板（Squad）。" : "No team templates (squads) found in the current project.",
        };
      }

      const lines: string[] = [];
      lines.push(zh ? `找到 ${squads.length} 个团队模板:` : `Found ${squads.length} team template(s):`);
      lines.push("");

      for (const sq of squads) {
        lines.push(`## ${sq.name} (ID: ${sq.id})`);
        lines.push(`Leader: ${sq.leader?.name || sq.leaderAgentId}`);
        lines.push(`Members (${sq.members.length}):`);
        for (const m of sq.members) {
          const role = m.roleDescription || "—";
          const leaderTag = m.memberId === sq.leaderAgentId ? " [LEADER]" : "";
          lines.push(`  - ${m.memberName} (${m.memberType})${leaderTag}: ${role}`);
        }
        if (sq.instructions) {
          lines.push(`Instructions: ${sq.instructions}`);
        }
        lines.push("");
      }

      return {
        title: `squad_list: ${squads.length} template(s)`,
        output: lines.join("\n"),
      };
    },
  };
}

// ========== 2. squad_dispatch ==========

export function createSquadDispatchTool(): ToolDef {
  return {
    id: "squad_dispatch",
  guidance: "Use squad_dispatch to turn a team template (squad) into a running agent-teams team for a task.",
    description:
      "Instantiate a team template (squad) into a running agent-teams team and dispatch a task to it. " +
      "The current session becomes the captain; template member roles are spawned as continuable subagents; " +
      "the task enters the shared pool and the scheduler wakes idle members to claim it (deterministic, role-based). " +
      "Use squad_list first to find the template ID. Returns the running team ID; monitor with agent_teams_status " +
      "or squad_status, direct members with agent_teams_send_message.",
    parameters: {
      type: "object",
      properties: {
        squad_id: {
          type: "string",
          description: "The team template (squad) ID to instantiate (use squad_list to find available templates)",
        },
        task: {
          type: "string",
          description: "The task description to hand to the running team",
        },
      },
      required: ["squad_id", "task"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const squadId = args.squad_id as string;
      const task = (args.task as string) || "";
      const mgr = getSquadManager();

      // Validate template exists
      const squad = mgr.getSquad(squadId);
      if (!squad) {
        return {
          title: "squad_dispatch",
          output: (zh ? "错误: 团队模板不存在: " : "Error: Team template not found: ") + squadId,
        };
      }
      if (squad.archived) {
        return {
          title: "squad_dispatch",
          output: (zh ? "错误: 团队模板已归档: " : "Error: Template is archived: ") + squad.name,
        };
      }
      const template = mgr.toTeamTemplate(squadId);
      if (!template) {
        return {
          title: "squad_dispatch",
          output: zh ? "错误: 无法导出团队模板" : "Error: failed to export team template",
        };
      }
      // 模板需至少一个可 spawn 的 agent 角色（human 角色无法成为运行时成员）
      const spawnable = template.roles.filter((r) => r.memberType === "agent");
      if (spawnable.length === 0) {
        return {
          title: "squad_dispatch",
          output:
            (zh ? "错误: 模板没有可执行的 agent 角色" : "Error: template has no spawnable agent roles") +
            ` (${squad.name})。\n` +
            (zh
              ? "请先在任务管理「团队」Tab 的模板里添加 agent 成员（角色），或用 agent_teams_create 直接建队。"
              : "Add agent member roles to the template (Task Center → Teams) first, or use agent_teams_create directly."),
        };
      }

      // Bridge: instantiate an agent-teams runtime team (captain = current session)
      const { AgentTeamsService } = await import("../provider/agent-teams-service");
      const svc = AgentTeamsService.getInstance();
      let team;
      try {
        team = svc.create({ name: squad.name, captainSessionId: ctx.sessionId });
      } catch (e: any) {
        return {
          title: "squad_dispatch",
          output:
            (zh ? "错误: 无法创建运行时团队" : "Error: cannot create running team") +
            `: ${e?.message || e}\n` +
            (zh
              ? "当前会话可能已作为队长带领一个活动团队（一人一队）——用 agent_teams_status 查看并用 agent_teams_delete 结束旧队后重试。"
              : "This session may already lead an active team (one team per captain). Check with agent_teams_status and delete it with agent_teams_delete, then retry."),
        };
      }

      // Spawn member roles from the template (human roles skipped — pre-validated ≥1 agent role)
      const spawnFailures: string[] = [];
      for (const role of spawnable) {
        try {
          await svc.addMember(team.id, {
            name: role.name,
            role: role.description || undefined,
            parentSessionId: ctx.sessionId,
          });
        } catch (e: any) {
          try { svc.removeMember(team.id, role.name); } catch { /* noop */ }
          spawnFailures.push(`${role.name} (${e?.message || e})`);
        }
      }

      // Create the task (shared pool; scheduler kicks idle members)
      const instructionsNote = template.instructions
        ? `\n\n# 团队指令（模板）\n${template.instructions}`
        : "";
      const fullDesc = task + instructionsNote;
      let created: any;
      try {
        created = svc.createTask(team.id, {
          subject: task.length > 80 ? `${task.slice(0, 80)}…` : task,
          description: fullDesc,
        }).task;
      } catch (e: any) {
        svc.deleteTeam(team.id);
        return {
          title: "squad_dispatch",
          output: (zh ? "错误: 派发任务失败，已回收团队: " : "Error: task creation failed, team rolled back: ") + (e?.message || e),
        };
      }

      return {
        title: `squad_dispatch: ${squad.name}`,
        output:
          (zh ? "已按模板创建运行时团队并派发任务" : "Team instantiated from template and task dispatched") +
          `\nTeam: ${squad.name} (${team.id})` +
          `\n` + (zh ? "队长: 当前会话（你）" : "Captain: current session (you)") +
          `\n` + (zh ? "任务: " : "Task: ") + task.substring(0, 200) +
          `\n` +
          (zh
            ? "成员已按角色就绪，调度器将唤醒空闲成员领取任务。用 agent_teams_status 查看进度、agent_teams_send_message 指导成员、agent_teams_update_task 更新状态。"
            : "Members are ready by role; the scheduler wakes idle members to claim the task. Use agent_teams_status to track, agent_teams_send_message to guide, agent_teams_update_task to update."),
        metadata: { teamId: team.id, taskId: created?.id || "", squadTemplateId: squadId, task: task.substring(0, 100) },
      };
    },
  };
}

// ========== 3. squad_status ==========

export function createSquadStatusTool(): ToolDef {
  return {
    id: "squad_status",
  guidance: "Use squad_status to check a team template (squad) and its instantiated running teams.",
    description:
      "Show a team template (squad) and the status of running agent-teams teams instantiated from it. " +
      "Pass team_id (from squad_dispatch / agent_teams_status) to inspect one specific running team. " +
      "Use this to monitor template-derived teamwork after squad_dispatch.",
    parameters: {
      type: "object",
      properties: {
        squad_id: {
          type: "string",
          description: "The team template (squad) ID to inspect",
        },
        team_id: {
          type: "string",
          description: "Optional: a specific running team ID to inspect (from squad_dispatch/agent_teams_status)",
        },
      },
      required: ["squad_id"],
    },
    async execute(args, _ctx) {
      const zh = getLang() === "zh";
      const squadId = args.squad_id as string;
      const teamId = (args.team_id as string) || "";
      const mgr = getSquadManager();
      const squad = mgr.getSquad(squadId);

      if (!squad) {
        return {
          title: "squad_status",
          output: (zh ? "错误: 团队模板不存在: " : "Error: Team template not found: ") + squadId,
        };
      }

      const lines: string[] = [];
      lines.push(`Template (Squad): ${squad.name} (${squadId})`);
      lines.push(`Status: ${squad.archived ? "Archived" : "Active"}`);
      lines.push(`Captain role: ${squad.leader?.name || squad.leaderAgentId}`);
      lines.push("");
      lines.push(zh ? `角色 (${squad.members.length}):` : `Roles (${squad.members.length}):`);
      for (const m of squad.members) {
        const leaderTag = m.memberId === squad.leaderAgentId ? " [CAPTAIN]" : "";
        lines.push(`  - ${m.memberName}${leaderTag}: ${m.roleDescription || "—"}`);
      }
      if (squad.instructions) {
        lines.push("");
        lines.push((zh ? "模板指令: " : "Instructions: ") + squad.instructions);
      }

      // Running teams derived from this template (agent-teams runtime)
      const { AgentTeamsService } = await import("../provider/agent-teams-service");
      const svc = AgentTeamsService.getInstance();
      const derived = svc.listAll().filter((t) => !t.archived && t.name === squad.name);
      const focus = teamId ? derived.filter((t) => t.id === teamId) : derived;

      lines.push("");
      if (focus.length === 0) {
        lines.push(zh ? "暂无从此模板实例化的运行时团队（用 squad_dispatch 创建）。" : "No running teams instantiated from this template yet (use squad_dispatch).");
      } else {
        lines.push(zh ? `运行时团队 (${focus.length}):` : `Running teams (${focus.length}):`);
        for (const t of focus) {
          try {
            const snap = svc.status(t.id);
            const memberLine = snap.members?.map((m: any) => `${m.name}(${m.status})`).join(", ") || "";
            const taskCount = (snap.tasks || []).reduce((acc: any, tk: any) => {
              acc[tk.status] = (acc[tk.status] || 0) + 1;
              return acc;
            }, {} as Record<string, number>);
            const taskSummary = Object.entries(taskCount).map(([k, v]) => `${k}:${v}`).join(" ") || "no tasks";
            lines.push(`  # ${t.name} (${t.id})`);
            lines.push(`    ${zh ? "成员" : "Members"}: ${memberLine || "—"}`);
            lines.push(`    ${zh ? "任务" : "Tasks"}: ${taskSummary}`);
          } catch {
            lines.push(`  # ${t.name} (${t.id}) — ${zh ? "状态不可读" : "status unavailable"}`);
          }
        }
      }

      return {
        title: `squad_status: ${squad.name}`,
        output: lines.join("\n"),
      };
    },
  };
}
