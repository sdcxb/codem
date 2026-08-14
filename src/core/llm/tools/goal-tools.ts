/**
 * P2-12: Goal Tools — create_goal / get_goal / update_goal
 *
 * 让 LLM 可以创建、查询、更新目标，实现自动续行。
 * 对标 dsh 的 goal-round-driver。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { createGoal, getGoal, listGoals, updateGoal } from "../../goal/goal";

export function createGoalTools(): ToolDef[] {
  return [
    // create_goal
    {
      id: "create_goal",
      description: `Create a new goal for the current task. Goals help track progress and enable automatic continuation.

Use this when you have a multi-step task that needs structured tracking. After creating a goal, work towards completing it and use update_goal to mark progress.`,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the goal" },
          description: { type: "string", description: "Detailed description of what needs to be done" },
          priority: { type: "string", enum: ["low", "normal", "high"], description: "Goal priority (default: normal)" },
          successCriteria: { type: "string", description: "How to verify the goal is complete" },
        },
        required: ["title"],
      },
      async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
        const goal = createGoal({
          sessionId: ctx.sessionId,
          title: args.title as string,
          description: args.description as string | undefined,
          status: "in_progress",
          priority: (args.priority as "low" | "normal" | "high") || "normal",
          successCriteria: args.successCriteria as string | undefined,
        });
        return {
          title: "Goal Created",
          output: `✅ Goal created: ${goal.title}\nID: ${goal.id}\nStatus: in_progress\nPriority: ${goal.priority}${goal.successCriteria ? `\nSuccess criteria: ${goal.successCriteria}` : ""}`,
        };
      },
    },

    // get_goal
    {
      id: "get_goal",
      description: `Get details of a specific goal by ID, or list all goals for the current session if no ID is provided.`,
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "The goal ID to retrieve. If omitted, lists all goals for the current session." },
        },
      },
      async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
        if (args.goalId) {
          const goal = getGoal(args.goalId as string);
          if (!goal) {
            return { title: "get_goal", output: `Goal not found: ${args.goalId}` };
          }
          return {
            title: `Goal: ${goal.title}`,
            output: `ID: ${goal.id}\nTitle: ${goal.title}\nStatus: ${goal.status}\nPriority: ${goal.priority}${goal.description ? `\nDescription: ${goal.description}` : ""}${goal.successCriteria ? `\nSuccess criteria: ${goal.successCriteria}` : ""}`,
          };
        }
        // List all goals
        const goals = listGoals(ctx.sessionId);
        if (goals.length === 0) {
          return { title: "get_goal", output: "No goals found for this session." };
        }
        const lines = goals.map(g => `- [${g.status}] ${g.title} (${g.id})${g.priority !== "normal" ? ` [${g.priority}]` : ""}`);
        return {
          title: `Goals (${goals.length})`,
          output: lines.join("\n"),
        };
      },
    },

    // update_goal
    {
      id: "update_goal",
      description: `Update a goal's status, title, or other fields.

Status transitions:
- pending → in_progress: Start working on the goal
- in_progress → completed: Goal is done
- in_progress → blocked: Cannot proceed, needs user input
- blocked → in_progress: User provided input, resuming
- any → cancelled: Goal is no longer needed`,
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "The goal ID to update" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked", "cancelled"], description: "New status" },
          title: { type: "string", description: "Updated title (optional)" },
          description: { type: "string", description: "Updated description (optional)" },
        },
        required: ["goalId"],
      },
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const goalId = args.goalId as string;
        const update: Record<string, unknown> = {};
        if (args.status) update.status = args.status;
        if (args.title) update.title = args.title;
        if (args.description) update.description = args.description;

        updateGoal(goalId, update as any);

        const goal = getGoal(goalId);
        if (!goal) {
          return { title: "update_goal", output: `Goal not found: ${goalId}` };
        }
        return {
          title: "Goal Updated",
          output: `✅ Goal "${goal.title}" updated. Status: ${goal.status}`,
        };
      },
    },
  ];
}
