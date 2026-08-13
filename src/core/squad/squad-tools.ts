/**
 * Squad Tools — LLM 工具注册
 *
 * 三个工具：
 * 1. squad_list — 列出当前项目的所有 Squad（含成员）
 * 2. squad_dispatch — 向 Squad Leader 派发任务
 * 3. squad_status — 查询 Squad 某个任务的执行状态
 *
 * 注册方式：在 LLMEngine.setupDelegationTools() 中调用
 */

import type { ToolDef } from "../llm/tools";
import { getSquadManager } from "./squad";
import { getDelegationOrchestrator } from "../session";
import { useProjectStore } from "../store";
import { getLang } from "../i18n/lang";

// ========== 1. squad_list ==========

export function createSquadListTool(): ToolDef {
  return {
    id: "squad_list",
    description:
      "List all squads in the current project. Returns each squad's name, leader, members, and instructions. " +
      "Use this before squad_dispatch to find available squad IDs.",
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
          output: zh ? "当前项目暂无 Squad。" : "No squads found in the current project.",
        };
      }

      const lines: string[] = [];
      lines.push(zh ? `找到 ${squads.length} 个 Squad:` : `Found ${squads.length} squad(s):`);
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
        title: `squad_list: ${squads.length} squad(s)`,
        output: lines.join("\n"),
      };
    },
  };
}

// ========== 2. squad_dispatch ==========

export function createSquadDispatchTool(): ToolDef {
  return {
    id: "squad_dispatch",
    description:
      "Dispatch a task to a squad's leader agent. The leader will receive the task along with the squad roster " +
      "(member names, roles, and mention links) and decide which member should handle the work. " +
      "Use squad_list first to find the squad ID. Returns a delegation task ID.",
    parameters: {
      type: "object",
      properties: {
        squad_id: {
          type: "string",
          description: "The squad ID to dispatch to (use squad_list to find available squads)",
        },
        task: {
          type: "string",
          description: "The task description to dispatch to the squad leader",
        },
      },
      required: ["squad_id", "task"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const squadId = args.squad_id as string;
      const task = args.task as string;
      const mgr = getSquadManager();

      // Validate squad exists
      const squad = mgr.getSquad(squadId);
      if (!squad) {
        return {
          title: "squad_dispatch",
          output: (zh ? "错误: Squad 不存在: " : "Error: Squad not found: ") + squadId,
        };
      }

      if (squad.archived) {
        return {
          title: "squad_dispatch",
          output: (zh ? "错误: Squad 已归档: " : "Error: Squad is archived: ") + squad.name,
        };
      }

      // Generate the squad roster for the leader
      const roster = mgr.generateSquadRoster(squadId);
      if (!roster) {
        return {
          title: "squad_dispatch",
          output: (zh ? "错误: 无法生成 Squad Roster" : "Error: Failed to generate squad roster"),
        };
      }

      // Compose the full task message for the leader
      const fullTask = [
        task,
        "",
        roster,
      ].join("\n");

      // Trigger a custom event that App.tsx listens for
      window.dispatchEvent(new CustomEvent("codem-squad-dispatch", {
        detail: {
          squadId,
          task: fullTask,
          originalTask: task,
          sourceSessionId: ctx.sessionId,
          projectId: useProjectStore.getState().currentProject?.id || "",
        },
      }));

      return {
        title: `squad_dispatch: ${squad.name}`,
        output:
          (zh ? "已向 Squad 派发任务" : "Task dispatched to squad") +
          `\nSquad: ${squad.name} (${squadId})` +
          `\nLeader: ${squad.leader?.name || squad.leaderAgentId}` +
          `\n` +
          (zh ? "任务描述: " : "Task: ") + task.substring(0, 200) +
          `\n\n` +
          (zh
            ? "Leader 会话已创建并开始处理。Leader 将根据成员角色决定由谁执行。"
            : "Leader session has been created and is processing. The leader will route to the appropriate member based on roles."),
        metadata: { squadId, task: task.substring(0, 100) },
      };
    },
  };
}

// ========== 3. squad_status ==========

export function createSquadStatusTool(): ToolDef {
  return {
    id: "squad_status",
    description:
      "Check the status of a squad — lists all members and whether they are currently executing tasks. " +
      "Use this to monitor squad progress after dispatching work.",
    parameters: {
      type: "object",
      properties: {
        squad_id: {
          type: "string",
          description: "The squad ID to check status for",
        },
      },
      required: ["squad_id"],
    },
    async execute(args, _ctx) {
      const zh = getLang() === "zh";
      const squadId = args.squad_id as string;
      const mgr = getSquadManager();
      const squad = mgr.getSquad(squadId);

      if (!squad) {
        return {
          title: "squad_status",
          output: (zh ? "错误: Squad 不存在: " : "Error: Squad not found: ") + squadId,
        };
      }

      // Check delegation tasks related to this squad
      const orch = getDelegationOrchestrator();
      const allTasks = squad.members.flatMap((m) => {
        // Check if any member has pending delegation tasks
        const sourceTasks = orch.getDelegationsBySource(m.memberId);
        const targetTasks = orch.getDelegationsByTarget(m.memberId);
        return [...sourceTasks, ...targetTasks];
      });

      const activeTasks = allTasks.filter((t) => t.status === "running" || t.status === "pending");
      const completedTasks = allTasks.filter((t) => t.status === "completed");

      const lines: string[] = [];
      lines.push(`Squad: ${squad.name} (${squadId})`);
      lines.push(`Status: ${squad.archived ? "Archived" : "Active"}`);
      lines.push(`Leader: ${squad.leader?.name || squad.leaderAgentId}`);
      lines.push("");
      lines.push(zh ? `成员状态 (${squad.members.length}):` : `Members (${squad.members.length}):`);
      for (const m of squad.members) {
        const memberTasks = allTasks.filter((t) => t.sourceSessionId === m.memberId || t.targetSessionId === m.memberId);
        const active = memberTasks.filter((t) => t.status === "running").length;
        const leaderTag = m.memberId === squad.leaderAgentId ? " [LEADER]" : "";
        const status = active > 0 ? (zh ? ` (${active} 个任务执行中)` : ` (${active} active)`) : "";
        lines.push(`  - ${m.memberName}${leaderTag}: ${m.roleDescription || "—"}${status}`);
      }
      lines.push("");
      lines.push(zh ? `活跃任务: ${activeTasks.length}` : `Active tasks: ${activeTasks.length}`);
      lines.push(zh ? `已完成任务: ${completedTasks.length}` : `Completed tasks: ${completedTasks.length}`);

      return {
        title: `squad_status: ${squad.name}`,
        output: lines.join("\n"),
      };
    },
  };
}
