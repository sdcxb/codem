/**
 * 跨会话委派工具 — 4 个新工具定义
 *
 * 1. delegate_to_session: 向另一个会话委派任务（非阻塞，返回 task_id）
 * 2. wait_for_delegation: 等待委派任务完成并获取结果
 * 3. query_session_result: 查询目标会话的最后输出
 * 4. list_sessions: 列出当前项目的所有会话
 *
 * 注册模式参考 tools.ts 中的 createSpawnSubagentTool / createWaitForSubagentTool。
 * 通过 setDelegationOrchestrator 注入单例。
 */

import type { ToolDef } from "../llm/tools";
import { getLang } from "../i18n/lang";
import { getDelegationOrchestrator } from "./orchestrator";
import * as MessageStorage from "../storage/message";
import * as SessionStorage from "../storage/session";
import { useProjectStore } from "../store";

// ========== 1. delegate_to_session ==========

export function createDelegateToSessionTool(): ToolDef {
  return {
    id: "delegate_to_session",
    description:
      "Delegate a task to another session's agent. The target session will auto-start processing in the background. " +
      "Returns immediately with a delegation task ID. Use wait_for_delegation to get the result when the target session completes. " +
      "Use list_sessions first to find available session IDs.",
    parameters: {
      type: "object",
      properties: {
        target_session_id: {
          type: "string",
          description: "The target session ID to delegate to (use list_sessions to find available sessions)",
        },
        task: {
          type: "string",
          description: "The task description to delegate to the target session's agent",
        },
      },
      required: ["target_session_id", "task"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const targetSessionId = args.target_session_id as string;
      const task = args.task as string;
      const orchestrator = getDelegationOrchestrator();

      // 获取当前项目 ID
      const project = useProjectStore.getState().currentProject;
      const projectId = project?.id || "";

      try {
        const delegationTask = await orchestrator.delegate({
          sourceSessionId: ctx.sessionId,
          targetSessionId,
          task,
          projectId,
        });

        return {
          title: `delegate_to_session: ${targetSessionId.substring(0, 12)}...`,
          output:
            (zh ? "委派任务已创建" : "Delegation task created") +
            `\nTASK_ID: ${delegationTask.id}\n` +
            (zh ? `目标会话: ${targetSessionId}` : `Target session: ${targetSessionId}`) +
            `\n` +
            (zh ? "任务描述: " : "Task: ") +
            task.substring(0, 200) +
            `\n\n` +
            (zh
              ? "目标会话已开始后台处理。使用 wait_for_delegation 获取结果。"
              : "Target session is now processing in the background. Use wait_for_delegation to get the result."),
          metadata: { delegationTaskId: delegationTask.id },
        };
      } catch (error: any) {
        return {
          title: "delegate_to_session",
          output: (zh ? "错误: " : "Error: ") + error.message,
        };
      }
    },
  };
}

// ========== 2. wait_for_delegation ==========

export function createWaitForDelegationTool(): ToolDef {
  return {
    id: "wait_for_delegation",
    description:
      "Wait for a delegation task to complete and get its result. Blocks until the target session finishes. " +
      "Use after delegate_to_session with the task_id returned by it.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The delegation task ID from delegate_to_session",
        },
      },
      required: ["task_id"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const taskId = args.task_id as string;
      const orchestrator = getDelegationOrchestrator();

      // 验证任务存在
      const task = orchestrator.getTask(taskId);
      if (!task) {
        return {
          title: "wait_for_delegation",
          output: zh
            ? `错误：未找到委派任务 "${taskId}"。请确保使用 delegate_to_session 返回的 task_id。`
            : `Error: Delegation task "${taskId}" not found. Make sure to use the task_id returned by delegate_to_session.`,
        };
      }

      try {
        // 轮询等待完成（复用 orchestrator.waitForCompletion）
        const completed = await orchestrator.waitForCompletion(taskId, ctx.abort);

        const statusL = zh ? "状态" : "Status";
        const resultL = zh ? "结果" : "Result";
        const sessionL = zh ? "来源会话" : "From session";

        return {
          title: `wait_for_delegation: ${taskId.substring(0, 16)}...`,
          output: `${statusL}: ${completed.status}\n${sessionL}: ${completed.targetSessionId}\n${resultL}:\n${completed.result || "(empty)"}`,
        };
      } catch (error: any) {
        // 如果是 abort 导致的取消
        if (ctx.abort?.aborted) {
          return {
            title: "wait_for_delegation",
            output: zh ? "等待已取消（主任务被中断）" : "Wait cancelled (parent task aborted)",
          };
        }
        return {
          title: "wait_for_delegation",
          output: (zh ? "错误: " : "Error: ") + error.message,
        };
      }
    },
  };
}

// ========== 3. query_session_result ==========

export function createQuerySessionResultTool(): ToolDef {
  return {
    id: "query_session_result",
    description:
      "Query the latest assistant output from a target session without delegating. " +
      "Useful for checking what another session has produced so far. Does not trigger new execution.",
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session ID to query",
        },
        message_count: {
          type: "number",
          description: "Number of recent assistant messages to retrieve (default: 1, max: 5)",
        },
      },
      required: ["session_id"],
    },
    async execute(args, _ctx) {
      const zh = getLang() === "zh";
      const sessionId = args.session_id as string;
      const count = Math.min((args.message_count as number) || 1, 5);

      // 从 DB 读取目标会话的消息
      const messages = MessageStorage.listMessages(sessionId);
      const assistantMessages = messages.filter((m) => m.role === "assistant" && m.content);

      if (assistantMessages.length === 0) {
        return {
          title: `query_session_result: ${sessionId.substring(0, 12)}...`,
          output: zh ? "该会话暂无 assistant 输出。" : "No assistant output in this session yet.",
        };
      }

      // 获取最近 N 条 assistant 消息
      const recent = assistantMessages.slice(-count);
      const output = recent
        .map((m, i) => {
          const header = `[${i + 1}/${recent.length}] ${zh ? "时间" : "Time"}: ${new Date(m.timestamp).toLocaleString()}`;
          const content = m.content.substring(0, 2000); // 限制单条 2000 字符
          const tools = m.toolCalls && m.toolCalls.length > 0
            ? `\n${zh ? "工具调用" : "Tool calls"}: ${m.toolCalls.map((tc) => tc.tool).join(", ")}`
            : "";
          return `${header}\n${content}${tools}`;
        })
        .join("\n\n---\n\n");

      return {
        title: `query_session_result: ${sessionId.substring(0, 12)}...`,
        output,
      };
    },
  };
}

// ========== 4. list_sessions ==========

export function createListSessionsTool(): ToolDef {
  return {
    id: "list_sessions",
    description:
      "List all sessions in the current project with their status. " +
      "Use this to find available target session IDs for delegate_to_session.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_args, ctx) {
      const zh = getLang() === "zh";

      // 从 store 获取当前项目的所有会话
      const sessions = useProjectStore.getState().sessions;

      if (sessions.length === 0) {
        return {
          title: "list_sessions",
          output: zh ? "当前项目没有会话。" : "No sessions in the current project.",
        };
      }

      const orchestrator = getDelegationOrchestrator();
      const activeExecutions = new Set<string>(); // 可扩展：从 executor 模块导入 isSessionExecuting

      const lines = sessions.map((s) => {
        const delegations = orchestrator.getDelegationsByTarget(s.id);
        const pendingCount = delegations.filter((d) => d.status === "pending" || d.status === "running").length;
        const status = activeExecutions.has(s.id)
          ? (zh ? "执行中" : "active")
          : pendingCount > 0
            ? (zh ? `委派中(${pendingCount})` : `delegated(${pendingCount})`)
            : (zh ? "空闲" : "idle");

        return `  ${s.id} | ${s.title} | ${status} | ${s.messageCount} msgs`;
      });

      const header = zh
        ? `会话列表 (${sessions.length} 个):\n  ID | 标题 | 状态 | 消息数`
        : `Sessions (${sessions.length}):\n  ID | Title | Status | Messages`;

      return {
        title: "list_sessions",
        output: header + "\n" + lines.join("\n"),
      };
    },
  };
}
