/**
 * SessionExecutor — 程序化触发会话执行
 *
 * 当 DelegationOrchestrator 接收到委派请求时，通过本模块在目标会话
 * 后台启动一次 agent loop 执行。与 App.tsx 中的 runAgenticLoop 不同，
 * 本模块不直接操作 React 状态，而是：
 *
 * 1. 直接调用 engine.process() 获取事件流
 * 2. 将消息写入 DB（MessageStorage）——用户切换到该会话时自然加载
 * 3. 通过 SessionMessageBus 发送状态更新（UI 层监听后刷新）
 * 4. 执行完成后通知 DelegationOrchestrator
 *
 * 设计参考：subagent/spawner.ts 的 LLMSubagentSpawner.executeTask
 */

import type { LLMEngine } from "../llm";
import type { LoopEvent } from "../llm/agentic-loop";
import * as MessageStorage from "../storage/message";
import * as SessionStorage from "../storage/session";
import { getSessionMessageBus } from "./bus";
import { getDelegationOrchestrator } from "./orchestrator";
import type { DelegationTask } from "./types";
import { useAppStore } from "../../store";
import { useProjectStore } from "../store";
import { getLang } from "../i18n/lang";

// ========== 类型 ==========

export interface ExecuteSessionTurnParams {
  /** 目标会话 ID */
  sessionId: string;
  /** 要执行的消息/任务描述 */
  message: string;
  /** 工作目录 */
  cwd: string;
  /** LLM 引擎实例 */
  engine: LLMEngine;
  /** 关联的委派任务 ID（可选，非委派触发时为空） */
  delegationTaskId?: string;
  /** abort 信号 */
  abortSignal?: AbortSignal;
  /** 权限请求回调（后台执行时由 UI 层提供） */
  onPermissionRequest?: (request: import("../permission/permission").PermissionRequest) => Promise<import("../permission/permission").PermissionResult>;
}

export interface ExecuteSessionTurnResult {
  /** 最终的 assistant 文本输出 */
  output: string;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 是否成功完成 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

// ========== 活跃执行追踪 ==========

/** 当前正在后台执行的会话集合 */
const activeExecutions = new Map<string, AbortController>();

// ========== 核心执行函数 ==========

/**
 * 在指定会话中程序化执行一次 agent loop。
 *
 * 这是 runAgenticLoop 的"后台精简版"：
 * - 不操作 React state（不调用 addMessage/addToolCall）
 * - 直接写 DB（MessageStorage.createMessage / addToolCall / updateToolCall）
 * - 通过 SessionMessageBus 广播状态（UI 层可选择性监听刷新）
 * - 完成后通知 DelegationOrchestrator
 */
export async function executeSessionTurn(params: ExecuteSessionTurnParams): Promise<ExecuteSessionTurnResult> {
  const { sessionId, message, cwd, engine, delegationTaskId, abortSignal, onPermissionRequest } = params;
  const zh = getLang() === "zh";
  const bus = getSessionMessageBus();
  const orchestrator = getDelegationOrchestrator();

  // 防止同一会话被重复执行
  if (activeExecutions.has(sessionId)) {
    const errMsg = zh ? `会话 ${sessionId} 已在执行中` : `Session ${sessionId} is already executing`;
    return { output: "", toolCallCount: 0, success: false, error: errMsg };
  }

  const abort = new AbortController();
  activeExecutions.set(sessionId, abort);

  // 联动外部 abort 信号
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => abort.abort());
  }

  // 标记会话为活跃（UI 层会显示 streaming 指示器）
  useAppStore.getState().setSessionActive(sessionId, true);

  // 通知 UI：后台执行开始
  bus.send(sessionId, {
    type: "status",
    sourceSessionId: delegationTaskId ? orchestrator.getTask(delegationTaskId)?.sourceSessionId || "" : "",
    targetSessionId: sessionId,
    detail: "execution_started",
    taskId: delegationTaskId,
  });

  let assistantContent = "";
  let reasoningContent = "";
  let toolCallCount = 0;
  let currentAssistantMsgId = "";

  // 标记委派任务为 running
  if (delegationTaskId) {
    orchestrator.startTask(delegationTaskId);
  }

  try {
    // 保存用户消息到 DB（委派任务作为 user message 注入目标会话）
    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const prefix = delegationTaskId ? "[DELEGATED TASK] " : "";
    MessageStorage.createMessage({
      id: userMsgId,
      role: "user",
      content: prefix + message,
      timestamp: Date.now(),
      status: "done",
    }, sessionId);

    // C5: EventLog dual-write — user message
    try {
      const { getEventLog } = require("../storage/event-log");
      getEventLog().append(sessionId, "user_message", {
        messageId: userMsgId,
        content: prefix + message,
      });
    } catch (e) { console.warn('[executor.ts]', e) }

    for await (const event of engine.process(sessionId, message, cwd, undefined, {
      onPermissionRequest: onPermissionRequest || ((_req) => {
        // 默认策略：后台执行时自动拒绝需要权限的操作
        return Promise.resolve({ approved: false, reason: "Background execution: auto-deny" } as any);
      }),
      // 后台执行使用默认 security mode（auto）
      securityMode: "auto",
    })) {
      if (abort.signal.aborted) break;

      switch (event.type) {
        case "reasoning_delta":
          reasoningContent += event.text;
          // 创建 assistant 消息（如果还没有）
          if (!currentAssistantMsgId) {
            currentAssistantMsgId = `assistant-${Date.now()}`;
            MessageStorage.createMessage({
              id: currentAssistantMsgId,
              role: "assistant",
              content: "",
              reasoning: reasoningContent,
              timestamp: Date.now(),
              status: "streaming",
            }, sessionId);
          } else {
            MessageStorage.updateMessage(currentAssistantMsgId, { reasoning: reasoningContent });
          }
          break;

        case "text_delta":
          assistantContent += event.text;
          if (!currentAssistantMsgId) {
            currentAssistantMsgId = `assistant-${Date.now()}`;
            MessageStorage.createMessage({
              id: currentAssistantMsgId,
              role: "assistant",
              content: assistantContent,
              timestamp: Date.now(),
              status: "streaming",
            }, sessionId);
          } else {
            MessageStorage.updateMessage(currentAssistantMsgId, { content: assistantContent });
          }
          break;

        case "tool_start": {
          const tc = "toolCall" in event ? event.toolCall : null;
          if (tc && currentAssistantMsgId) {
            MessageStorage.addToolCall(currentAssistantMsgId, {
              id: tc.id,
              tool: tc.name,
              args: { ...tc.input, name: tc.input?.name || (tc as any).metadata?.name },
              status: "running",
            });
          }
          break;
        }

        case "tool_complete": {
          toolCallCount++;
          const tc = "toolCall" in event ? event.toolCall : null;
          if (tc && currentAssistantMsgId) {
            let resultStr: string;
            if (typeof event.result === "string") {
              resultStr = event.result;
            } else if (event.result && typeof event.result === "object" && "output" in event.result) {
              resultStr = (event.result as any).output;
            } else {
              resultStr = JSON.stringify(event.result || "");
            }
            resultStr = resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            MessageStorage.updateToolCall(currentAssistantMsgId, tc.id, {
              status: "done",
              result: resultStr,
            });
          }
          break;
        }

        case "tool_error": {
          toolCallCount++;
          const tc = "toolCall" in event ? event.toolCall : null;
          const err = "error" in event ? event.error : "Unknown error";
          if (tc && currentAssistantMsgId) {
            MessageStorage.updateToolCall(currentAssistantMsgId, tc.id, {
              status: "error",
              result: err,
            });
          }
          break;
        }

        case "start": {
          // 新迭代：finalize 上一个 assistant message，创建新的
          const iter = "iteration" in event ? event.iteration : 1;
          if (iter > 1 && currentAssistantMsgId) {
            MessageStorage.updateMessage(currentAssistantMsgId, {
              status: "done",
              reasoning: reasoningContent || undefined,
            });
            currentAssistantMsgId = `assistant-${Date.now()}-${iter}`;
            assistantContent = "";
            reasoningContent = "";
          }
          break;
        }

        case "end":
          // 通知 UI 执行结束
          bus.send(sessionId, {
            type: "status",
            sourceSessionId: delegationTaskId ? orchestrator.getTask(delegationTaskId)?.sourceSessionId || "" : "",
            targetSessionId: sessionId,
            detail: "execution_completed",
            taskId: delegationTaskId,
          });
          break;
      }
    }

    // Finalize 最后的 assistant message
    if (currentAssistantMsgId) {
      MessageStorage.updateMessage(currentAssistantMsgId, {
        status: "done",
        content: assistantContent,
        reasoning: reasoningContent || undefined,
      });
      // C5: EventLog dual-write — assistant text
      try {
        const { getEventLog } = require("../storage/event-log");
        getEventLog().append(sessionId, "assistant_text", {
          messageId: currentAssistantMsgId,
          content: assistantContent,
        });
      } catch (e) { console.warn('[executor.ts]', e) }
    }

    // 如果用户正在查看这个会话，刷新消息列表
    const viewingSession = useProjectStore.getState().currentSession?.id;
    if (viewingSession === sessionId) {
      useAppStore.getState().loadMessages(sessionId);
    }

    // 过滤 system-reminder 标签
    const cleanOutput = assistantContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

    // 通知编排器任务完成
    if (delegationTaskId) {
      orchestrator.completeTask(delegationTaskId, cleanOutput || "[No output]");
    }

    return {
      output: cleanOutput,
      toolCallCount,
      success: true,
    };
  } catch (err: any) {
    console.error(`[SessionExecutor] Failed for session ${sessionId}:`, err);

    // 通知编排器任务失败
    if (delegationTaskId) {
      orchestrator.failTask(delegationTaskId, err.message || String(err));
    }

    // 写错误消息到 DB
    MessageStorage.createMessage({
      id: `err-${Date.now()}`,
      role: "system",
      content: `[Delegation Error] ${err.message || String(err)}`,
      timestamp: Date.now(),
      status: "error",
    }, sessionId);

    return {
      output: "",
      toolCallCount,
      success: false,
      error: err.message || String(err),
    };
  } finally {
    // 清理活跃执行追踪
    activeExecutions.delete(sessionId);

    // 标记会话为非活跃
    useAppStore.getState().setSessionActive(sessionId, false);

    // 如果是委派任务被 abort，标记为 cancelled
    if (abort.signal.aborted && delegationTaskId) {
      orchestrator.cancelTask(delegationTaskId);
    }
  }
}

// ========== 辅助方法 ==========

/** 检查指定会话是否正在后台执行 */
export function isSessionExecuting(sessionId: string): boolean {
  return activeExecutions.has(sessionId);
}

/** 取消指定会话的后台执行 */
export function cancelSessionExecution(sessionId: string): void {
  const controller = activeExecutions.get(sessionId);
  if (controller) {
    controller.abort();
  }
}

/**
 * 处理目标会话的待处理委派任务。
 * 在应用启动或会话切换时调用，检查是否有 pending 的委派需要执行。
 */
export async function processPendingDelegations(
  sessionId: string,
  engine: LLMEngine,
  cwd: string,
  onPermissionRequest?: ExecuteSessionTurnParams["onPermissionRequest"],
): Promise<void> {
  const orchestrator = getDelegationOrchestrator();
  const pending = orchestrator.getPendingDelegationsForTarget(sessionId);

  for (const task of pending) {
    if (isSessionExecuting(sessionId)) {
      // 会话正在执行，等待当前执行完成后再处理
      break;
    }

    console.log(`[SessionExecutor] Processing pending delegation ${task.id} for session ${sessionId}`);

    await executeSessionTurn({
      sessionId,
      message: task.task,
      cwd,
      engine,
      delegationTaskId: task.id,
      onPermissionRequest,
    });
  }
}
