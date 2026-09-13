/**
 * 跨会话委派工具 — 5 个工具定义
 *
 * 1. delegate_to_session: 向另一个会话委派任务（非阻塞，返回 task_id）
 * 2. wait_for_delegation: 等待委派任务完成（**有预算**，到点带进度返回）
 * 3. query_session_result: 查询目标会话的最后输出
 * 4. list_sessions: 列出当前项目的所有会话
 * 5. cancel_delegation: 终止一个卡住/跑偏的委派任务（第 63 波加）
 *
 * 注册模式参考 tools.ts 中的 createSpawnSubagentTool / createWaitForSubagentTool。
 * 通过 setDelegationOrchestrator 注入单例。
 */

import type { ToolDef } from "../llm/tools";
import { getLang } from "../i18n/lang";
import { getDelegationOrchestrator } from "./orchestrator";
import { cancelSessionExecution } from "./executor";
import { checkHandover } from "./handover";
import * as MessageStorage from "../storage/message";
import * as SessionStorage from "../storage/session";
import { useProjectStore } from "../store";

/**
 * 同一目标会话的"交接被拒次数"（第 63 波）。
 *
 * 校验必须**会放手**：如果模型始终写不出合规的交接，硬拦等于把"委派"这个功能彻底锁死 ——
 * 那比"交接写得不够好"严重得多。所以第 3 次起**放宽放行**，并把缺什么写在返回里，
 * 由接收方（executor 注入的兜底提示）自己报告缺信息，而不是靠大规模扫描去猜。
 */
const handoverRejections = new Map<string, number>();

/** 测试用：重置拒绝计数 */
export function resetHandoverRejections(): void {
  handoverRejections.clear();
}

// ========== 1. delegate_to_session ==========
export function createDelegateToSessionTool(): ToolDef {
  return {
    id: "delegate_to_session",
  guidance: "Use delegate_to_session to send a task to another session for execution. The target session runs independently.",
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

      // 第 63 波：交接协议机械校验（这是第 62 波事故的根因，守卫只是安全网）。
      // 缺"产物绝对路径/完成判据"或正文过长 → 直接拒绝并给改写指引，而不是把一团
      // 自由文本丢给接收方，让它从零重新遍历文件系统。
      const check = checkHandover(task);
      const rejections = handoverRejections.get(targetSessionId) ?? 0;
      // 前两次：拒绝并给出改写指引；第三次起放宽放行（见 handoverRejections 的说明）
      const failOpen = !check.ok && rejections >= 2;
      if (!check.ok && !failOpen) {
        handoverRejections.set(targetSessionId, rejections + 1);
        console.warn(
          `[delegate_to_session] 交接正文不合规（第 ${rejections + 1} 次；${check.stats.chars} 字，绝对路径=${check.stats.hasAbsolutePath}，完成判据=${check.stats.hasDoneCriteria}）`,
        );
        return {
          title: "delegate_to_session",
          output:
            (zh ? "交接正文不合规，已拒绝（未创建委派任务）：\n\n" : "Handover rejected (no task created):\n\n") +
            check.error +
            (zh
              ? `\n\n（连续被拒 3 次后会放宽放行 —— 校验是为了让交接更有效，不是拦住你干活。）`
              : `\n\n(After 3 rejections this check will stand down — it exists to make handovers work, not to block you.)`),
        };
      }
      if (check.ok && rejections > 0) handoverRejections.delete(targetSessionId);
      const relaxedNote = failOpen
        ? zh
          ? `\n\n⚠️ 已放宽放行：这份交接仍缺少必需内容（${check.error}）。接收方缺少信息时应先报告、不要盲目扫描。`
          : `\n\n⚠️ Passed in relaxed mode: this handover still lacks required content. The receiver is instructed to report missing info instead of scanning blindly.`
        : "";
      if (failOpen) {
        console.warn(`[delegate_to_session] 放宽放行（该目标会话已拒绝 ${rejections} 次）`);
        handoverRejections.delete(targetSessionId);
      }
      if (check.warning) {
        console.warn(`[delegate_to_session] ${check.warning}`);
      }

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
            relaxedNote +
            `\n\n` +
            (check.warning ? (zh ? `提醒：${check.warning}\n\n` : `Note: ${check.warning}\n\n`) : "") +
            (zh
              ? "目标会话已开始后台处理。使用 wait_for_delegation 获取结果（注意：等待有预算，到点会带着进度返回，不要反复空等）。"
              : "Target session is now processing in the background. Use wait_for_delegation (it returns with progress on budget — do not wait in a tight loop)."),
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
  guidance: "Use wait_for_delegation to block until a delegated session task completes.",
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
        // 第 62 波：等待有预算，到点带进度返回 —— 不再是无限期阻塞
        const completed = await orchestrator.waitForCompletion(taskId, ctx.abort);
        const zh = getLang() === "zh";

        // 仍在运行：给父会话「已跑多久 + 调了多少次工具 + 最新输出」，并给出可选动作。
        // 事故里父会话在这里黑等十几分钟，既不知道子会话在干什么，也无法脱身。
        if (completed.status === "running" || completed.status === "pending") {
          const elapsedSec = Math.round((Date.now() - (completed.startedAt ?? completed.createdAt)) / 1000);
          const waitedSec = Math.round((completed.waitedMs ?? 0) / 1000);
          const budgetExhausted = waitedSec * 1000 >= (orchestrator.getConfig().waitBudgetMs ?? Number.MAX_SAFE_INTEGER) * 0.95;
          const p = completed.progress;
          const lines = [
            zh
              ? `状态: 仍在运行（已 ${elapsedSec} 秒）—— 本轮等待到点返回，任务没有失败。`
              : `Status: still running (${elapsedSec}s elapsed) — this wait returned on budget, the task is NOT failed.`,
            zh ? `目标会话: ${completed.targetSessionId}` : `Target session: ${completed.targetSessionId}`,
            zh ? `累计已等待: ${waitedSec} 秒` : `Total time waited: ${waitedSec}s`,
            p ? (zh ? `已完成工具调用: ${p.toolCalls} 次` : `Tool calls so far: ${p.toolCalls}`) : "",
            p?.lastTool ? (zh ? `最近一次工具: ${p.lastTool}` : `Last tool: ${p.lastTool}`) : "",
            p?.lastText ? (zh ? `子会话最新输出:\n${p.lastText}` : `Latest child output:\n${p.lastText}`) : "",
            "",
            budgetExhausted
              ? zh
                ? `⚠️ **等待总预算已用完**：不要再调用 wait_for_delegation 了（再调也只会立刻返回同样的进度）。请改为：向用户报告子会话仍未完成 + 它卡在哪，然后继续做自己能做的事（或用 cancel_delegation 终止它）。`
                : `⚠️ The overall wait budget is exhausted: do NOT call wait_for_delegation again (it will only return this same progress). Report to the user that the child is still running and where it is stuck, then proceed with other work (or cancel it).`
              : zh
                ? `你可以：① 继续等待（再调一次 wait_for_delegation("${taskId}")，受总预算约束）；② 先做别的事，稍后再收结果。`
                : `You can: (1) wait again via wait_for_delegation("${taskId}") within the total budget; (2) do other work and collect later.`,
            zh
              ? `如果子会话的「最近一次工具」看起来在**反复做同一件事**，不要继续干等 —— 用 cancel_delegation 终止它，或直接告诉用户它卡住了。`
              : `If the child's last tool looks like it is repeating the same action, do NOT keep waiting — cancel it or report to the user that it is stuck.`,
          ].filter(Boolean);
          return {
            title: `wait_for_delegation: ${taskId.substring(0, 16)}... (running)`,
            output: lines.join("\n"),
          };
        }

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
  guidance: "Use query_session_result to retrieve the result of a completed session delegation.",
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
  guidance: "Use list_sessions to see all active sessions and their statuses.",
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

// ========== 5. cancel_delegation ==========

/**
 * 终止一个委派任务（第 63 波）。
 *
 * 为什么必须有它：第 62 波事故里，父会话发现子会话卡住之后**没有任何手段** ——
 * 只能继续等（或等到墙钟上限），用户看到的就是"卡住"。有了这个工具，父会话可以
 * 「发现原地打转 → 终止 → 报告」，而不是把时间耗在等待上。
 * 终止走的是编排器的取消 + executor 的 AbortController（子会话的循环会立刻 break）。
 */
export function createCancelDelegationTool(): ToolDef {
  return {
    id: "cancel_delegation",
    guidance:
      "Use cancel_delegation to stop a delegated task that is stuck (e.g. repeating the same action) or no longer needed.",
    description:
      "Cancel a delegation task by its task_id. Aborts the target session's background run immediately. " +
      "Use this when the child session looks stuck in a loop, or when the user says the delegated work is no longer needed.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The delegation task ID returned by delegate_to_session",
        },
        reason: {
          type: "string",
          description: "Short reason shown in logs and to the user (optional)",
        },
      },
      required: ["task_id"],
    },
    async execute(args, _ctx) {
      const zh = getLang() === "zh";
      const taskId = args.task_id as string;
      const reason = (args.reason as string) || (zh ? "调用方主动终止" : "cancelled by caller");
      const orchestrator = getDelegationOrchestrator();

      const task = orchestrator.getTask(taskId);
      if (!task) {
        return {
          title: "cancel_delegation",
          output: zh
            ? `错误：未找到委派任务 "${taskId}"。`
            : `Error: Delegation task "${taskId}" not found.`,
        };
      }

      const alreadyDone = task.status === "completed" || task.status === "failed" || task.status === "cancelled";

      // 1) 先掐掉子会话正在跑的后台循环（这是真正"停手"的一步）
      cancelSessionExecution(task.targetSessionId);
      // 2) 再把编排器里的任务状态置为 cancelled（父会话后续 wait 会立刻拿到 cancelled）
      if (!alreadyDone) orchestrator.cancelTask(taskId);

      console.log(`[cancel_delegation] ${taskId} → 目标会话 ${task.targetSessionId} 已中止（${reason}）`);

      return {
        title: `cancel_delegation: ${taskId.substring(0, 16)}...`,
        output: alreadyDone
          ? zh
            ? `任务 "${taskId}" 已经是 ${task.status} 状态，无需终止。`
            : `Task "${taskId}" is already ${task.status}; nothing to cancel.`
          : zh
            ? `已终止委派任务 "${taskId}"（目标会话: ${task.targetSessionId}）。原因: ${reason}\n` +
              `子会话已完成的部分产出仍可用 query_session_result 查看。请向用户说明：任务被主动终止 + 终止原因 + 已经拿到的部分结果。`
            : `Cancelled delegation task "${taskId}" (target session: ${task.targetSessionId}). Reason: ${reason}\n` +
              `Partial output is still available via query_session_result. Tell the user: the task was cancelled, why, and what partial results exist.`,
      };
    },
  };
}
