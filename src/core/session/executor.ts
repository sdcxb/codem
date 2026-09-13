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
import { idleWatchdog } from "./idle-watchdog";
import { recordLoopStop } from "../llm/loop-stop-log";
import { getDelegationOrchestrator } from "./orchestrator";
import type { DelegationTask } from "./types";
import { useAppStore } from "../../store";
import { useProjectStore } from "../store";
import { getEventLog } from "../storage/event-log";
import { getLang } from "../i18n/lang";
import { getEffectiveSecurityMode } from "../permission/security-mode";

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

/**
 * 第 65 波：把一个循环事件折算成"吃了多少上下文"的粗略估计（字符数）。
 *
 * 只统计模型自己吐出的 text/reasoning 是不够的 —— 真正把上下文撑满的是**工具结果**
 * （一次列出几千行、一次读一个文件），以及**工具入参**（写文件时整篇内容都在入参里）。
 * 这里把三者都算上，再除以 3 换算成估算 token（与工具栏的估算口径一致）。
 */
function estimateEventTokens(event: any): string | undefined {
  const parts: string[] = [];
  if (typeof event?.text === "string") parts.push(event.text);
  if (event?.toolCall?.input) {
    try { parts.push(JSON.stringify(event.toolCall.input)); } catch { /* 忽略不可序列化的入参 */ }
  }
  const result = event?.result;
  if (typeof result === "string") parts.push(result);
  else if (result && typeof result === "object" && typeof result.output === "string") parts.push(result.output);
  return parts.length > 0 ? parts.join("") : undefined;
}

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
  // P6：记录 end 事件的 stop reason（too_many_errors/max_iterations/no_progress/overflow…），
  // 用于"无任何文本产出即异常终止"时落库并返回失败（否则微信/手机端静默无回复）。
  let endReason: string | undefined;

  // 第 64 波（用户质疑「用时间做可靠性」之后重做）：
  // 原来是「15 分钟墙钟上限」—— 那是**错的机制**：合法的长任务（装依赖、跑全量测试、编译）
  // 会被误杀，而"还在产出废话"的卡死循环在到点前谁也拦不住。
  // 现在按 DSH 的分法（`@deepseek-ai/dsh-timeout`）：
  //   · **空闲看门狗**（时间只用于测"沉默"）：每个事件 `pulse()` 一次，只有连续 N 分钟
  //     **一个事件都没有**才中止 —— 还在干活就永远不会被杀；
  //   · **资源预算**（上限用资源而不是时钟）：后台会话累计估算 token 超过预算才中止。
  // 两者都是"配置项"，不是散落的魔法数字（DSH 同样把上限放在 settings schema 里）。
  let abortedBy: "idle" | "budget" | "tool_hung" | "cancel" | null = null;
  let lastToolLabel = "";
  const delegCfg = getDelegationOrchestrator().getConfig?.();
  const idleMs = delegCfg?.turnIdleMs ?? 5 * 60 * 1000;
  const tokenBudget = delegCfg?.turnTokenBudget ?? 0; // 0 = 不限
  const watchdog = idleWatchdog(abort.signal, idleMs, "BACKGROUND_TURN_IDLE");
  let estimatedTokens = 0;

  /**
   * 第 65 波（审计发现）：**"事件流沉默"不等于"卡住"** —— 一个跑了 10 分钟的构建/测试
   * 期间本来就不会有事件。原来的空闲看门狗会把这种**合法长工具**当成卡死砍掉，
   * 父会话也会看到"安静 3 分钟"而误以为它卡住。
   *
   * 按 DSH 的思路把两种语义拆开（它的 `deadline` 与 `idleWatchdog` 也是分给不同能力的）：
   *   · **空闲**（`idle`）：既没有事件、也没有工具在跑，连续 `idleMs` → 才是真的停摆；
   *   · **工具挂死**（`tool_hung`）：单个工具在飞超过 `toolFlightMs`（默认 20 分钟）→ 那个工具卡死了
   *     （正常情况下工具自己的超时会更早触发）。
   * 工具在飞期间每 30 秒心跳一次：既给看门狗续命，也**向父会话上报进度**（它据此知道"还在干活"）。
   */
  const toolFlightMs = delegCfg?.toolFlightMs ?? 20 * 60 * 1000;
  let toolsInFlight = 0;
  let toolFlightTimer: ReturnType<typeof setTimeout> | undefined;
  const clearToolFlight = () => {
    if (toolFlightTimer !== undefined) clearTimeout(toolFlightTimer);
    toolFlightTimer = undefined;
  };
  const armToolFlight = () => {
    if (toolFlightTimer !== undefined || toolFlightMs <= 0) return;
    toolFlightTimer = setTimeout(() => {
      abortedBy = "tool_hung";
      console.warn(`[Executor] 会话 ${sessionId} 的工具 ${lastToolLabel || "(unknown)"} 在飞超过 ${Math.round(toolFlightMs / 1000)}s，判定挂死并中止`);
      abort.abort();
    }, toolFlightMs);
    (toolFlightTimer as any)?.unref?.();
  };

  // 工具在飞期间的心跳：续命 + 上报进度（父会话的"安静判定"据此保持正确）
  const flightHeartbeat = setInterval(() => {
    if (toolsInFlight <= 0) return;
    watchdog.pulse();
    reportProgress();
  }, 30_000);
  (flightHeartbeat as any)?.unref?.();

  // 标记委派任务为 running
  if (delegationTaskId) {
    orchestrator.startTask(delegationTaskId);
  }

  /** 第 62 波：把进度上报给编排器（等待超时的父会话据此看到子会话在干什么） */
  const reportProgress = () => {
    if (!delegationTaskId) return;
    orchestrator.updateProgress(delegationTaskId, {
      toolCalls: toolCallCount,
      lastText: assistantContent.slice(-400),
      lastTool: lastToolLabel || undefined,
    });
  };

  /**
   * 每个事件都算一次"还活着"：重新上弦空闲看门狗，并累计估算 token 预算。
   * 这是与"墙钟"最关键的区别 —— 时间只在**没有事件**时流逝。
   */
  const noteActivity = (text?: string) => {
    watchdog.pulse();
    if (typeof text === "string" && text.length > 0) {
      estimatedTokens += Math.ceil(text.length / 3);
      if (tokenBudget > 0 && estimatedTokens > tokenBudget) {
        abortedBy = "budget";
        console.warn(
          `[Executor] 会话 ${sessionId} 累计估算 token 超过预算 ${tokenBudget}（约 ${estimatedTokens}），按资源上限中止`,
        );
        abort.abort();
      }
    }
  };

  try {
    // 保存用户消息到 DB（委派任务作为 user message 注入目标会话）
    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const prefix = delegationTaskId ? "[DELEGATED TASK] " : "";
    // 第 63 波（审计补）：给"接收方"一句兜底约束。
    // 交接正文再规范，也可能漏东西；漏了的时候模型的本能是"把整个盘扫一遍找找看" ——
    // 那正是第 62 波事故的行为。所以这句必须由系统注入（而不是指望交接里写了）。
    const receiverNote = delegationTaskId
      ? (getLang() === "zh"
          ? "\n\n---\n[系统提示] 这是一次**会话交接**：上面是对方给你的全部信息，你没有它的对话历史。" +
            "需要文件内容时，**直接用正文里给出的绝对路径 read**；" +
            "如果正文缺少你要的信息（文件不存在、路径没给、完成判据不清），**先明确报告缺什么**，" +
            "不要靠反复枚举目录/递归扫描来猜。同一个目录枚举超过几次就会被系统拦下并终止。"
          : "\n\n---\n[SYSTEM] This is a session handover: the text above is ALL you get — you have none of the sender's history. " +
            "When you need file content, `read` the absolute path given above. " +
            "If something you need is missing (no path, file not found, no definition of done), REPORT WHAT IS MISSING first — " +
            "do not guess by repeatedly enumerating directories or scanning recursively. Repeated enumeration of the same target gets blocked and terminated.")
      : "";
    MessageStorage.createMessage({
      id: userMsgId,
      role: "user",
      content: prefix + message + receiverNote,
      timestamp: Date.now(),
      status: "done",
    }, sessionId);

    // C5: EventLog dual-write — user message
    try {
      getEventLog().append(sessionId, "user_message", {
        messageId: userMsgId,
        content: prefix + message,
      });
    } catch (e) { console.warn('[executor.ts]', e) }

    // 委派/后台任务同样遵循用户选择的安全模式（项目级 > 全局 > 默认 ask），
    // 不再硬编码 "auto" —— 否则用户在 UI 选择"完全访问"后委派任务仍被权限层拦截。
    const effectiveSecurityMode = getEffectiveSecurityMode(cwd) || "ask";
    for await (const event of engine.process(sessionId, message, cwd, undefined, {
      onPermissionRequest: onPermissionRequest || ((_req) => {
        // 默认策略：后台执行时若用户模式为 full 则放行；否则自动拒绝需要权限的操作
        if (effectiveSecurityMode === "full") {
          return Promise.resolve({ requestId: _req?.id || "", action: "allow", alwaysAllow: false } as any);
        }
        return Promise.resolve({ requestId: _req?.id || "", action: "deny", reason: "Background execution: auto-deny" } as any);
      }),
      securityMode: effectiveSecurityMode,
    })) {
      if (abort.signal.aborted) break;
      // 每个事件都是"还活着"的证据：重新上弦空闲看门狗 + 计入资源预算。
      // 第 65 波修正：预算必须把**工具输入/输出**也算进去 —— 只统计模型吐出的文本
      // 会严重低估（真正吃上下文的是工具结果），于是预算形同虚设。
      noteActivity(estimateEventTokens(event as any));

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
          if (tc) {
            // 第 62 波：记下"最近一次工具"，等待超时的父会话据此判断子会话是否在原地打转
            const raw = (tc.input as any)?.command ?? (tc.input as any)?.path ?? "";
            lastToolLabel = `${tc.name}${raw ? `: ${String(raw).replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
            // 第 65 波：工具在飞 → 让空闲看门狗"暂停判定"，并另起一道"工具挂死"上限
            toolsInFlight++;
            armToolFlight();
            reportProgress();
          }
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
          toolsInFlight = Math.max(0, toolsInFlight - 1);
          if (toolsInFlight === 0) clearToolFlight();
          reportProgress();
          const tc = "toolCall" in event ? event.toolCall : null;
          if (tc && currentAssistantMsgId) {
            let resultStr: string;
            let toolMetadata: Record<string, any> | undefined;
            if (typeof event.result === "string") {
              resultStr = event.result;
            } else if (event.result && typeof event.result === "object" && "output" in event.result) {
              resultStr = (event.result as any).output;
              // 提取结构化元数据（如 subagentId 等）
              if ((event.result as any).metadata) {
                toolMetadata = (event.result as any).metadata;
              }
            } else {
              resultStr = JSON.stringify(event.result || "");
            }
            resultStr = resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            MessageStorage.updateToolCall(currentAssistantMsgId, tc.id, {
              status: "done",
              result: resultStr,
              ...(toolMetadata ? { metadata: toolMetadata } : {}),
            });
          }
          break;
        }

        case "tool_error": {
          toolCallCount++;
          toolsInFlight = Math.max(0, toolsInFlight - 1);
          if (toolsInFlight === 0) clearToolFlight();
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
          endReason = (event as any)?.result?.reason || (event as any)?.reason || undefined;
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
        const { getEventLog } = await import("../storage/event-log");
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

    // 第 64 波：被"空闲看门狗"或"资源预算"中止 —— 明确说明是哪一种，并把已有产出交回去。
    // 注意这**不是**"到点就杀"：还在产出的事件会让看门狗不断重新上弦（合法长任务不会被误杀）。
    if (watchdog.timedOut() || abortedBy) {
      const zht = getLang() === "zh";
      const reason: "idle" | "budget" | "tool_hung" =
        abortedBy === "budget" ? "budget" : abortedBy === "tool_hung" ? "tool_hung" : "idle";
      const note =
        reason === "budget"
          ? zht
            ? `[后台执行达到资源上限：估算 token 约 ${estimatedTokens} / 预算 ${tokenBudget}] 已完成 ${toolCallCount} 次工具调用，最近一次工具：${lastToolLabel || "(无)"}。` +
              `如果这是正常的大任务，请提高预算或拆小；如果是原地打转，检查它是否在重复同一件事。`
            : `[Background turn hit its token budget: ~${estimatedTokens} / ${tokenBudget}] ${toolCallCount} tool calls, last tool: ${lastToolLabel || "(none)"}.`
          : reason === "tool_hung"
            ? zht
              ? `[工具挂死：${lastToolLabel || "(unknown)"} 在飞超过 ${Math.round(toolFlightMs / 1000)} 秒] 已强制中止。` +
                `注意这**不是**"跑得久被砍"——工具自己的超时本该更早触发；请检查该工具是否需要更长的超时或是否真的卡住。`
              : `[Tool hung: ${lastToolLabel || "(unknown)"} in flight for over ${Math.round(toolFlightMs / 1000)}s] aborted.`
            : zht
              ? `[后台执行空闲超时：连续 ${Math.round(idleMs / 1000)} 秒**既没有事件、也没有工具在跑**] 已完成 ${toolCallCount} 次工具调用，最近一次工具：${lastToolLabel || "(无)"}。` +
                `空闲超时意味着**它已经不产出任何东西**（不是"跑得久"）—— 常见原因是模型停摆或 provider 无响应。`
              : `[Background turn idle timeout: no event and no tool in flight for ${Math.round(idleMs / 1000)}s] ${toolCallCount} tool calls, last tool: ${lastToolLabel || "(none)"}.`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: note,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      // 第 65 波：停止原因结构化落库（idle / budget 两类），便于统计"哪种卡法最多"
      recordLoopStop(sessionId, reason, {
        toolCalls: toolCallCount,
        lastTool: lastToolLabel,
        estimatedTokens,
        tokenBudget,
        idleMs,
      });
      if (delegationTaskId) {
        orchestrator.failTask(delegationTaskId, `${note}\n\n${zht ? "已产出的内容" : "Partial output"}:\n${cleanOutput || "(none)"}`);
      }
      return { output: cleanOutput, toolCallCount, success: false, error: note };
    }

    // P6：end 事件带异常 reason 且无任何文本产出 → 落库 system error 并返回失败
    //（对照 App runAgenticLoop 的 loop-error-* 行为；否则微信/手机端静默无回复）。
    // 判据：只要 endReason 存在且非正常 "completed" 即视为异常——覆盖全部 reason
    //（too_many_errors/max_iterations/no_progress/overflow/safety_valve/
    //  critical_service_unavailable/write_rejected_by_user/cost limit 长串等），
    // 避免枚举集合漏掉新增 reason。
    if (!cleanOutput && endReason && endReason !== "completed") {
      const errMsg = `[Agentic 循环异常终止: ${endReason}] 请检查会话详情或重试。`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: errMsg,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      // 通知编排器任务失败（若为委派触发）
      if (delegationTaskId) {
        orchestrator.failTask(delegationTaskId, errMsg);
      }
      return {
        output: "",
        toolCallCount,
        success: false,
        error: `循环异常终止: ${endReason}`,
      };
    }

    // 第 65 波（审计发现）：循环因**停滞/打转**类原因停止时，即使模型吐了文字，
    // 也不能当成"任务完成"上报 —— 否则父会话收到一个"已完成"、实际是"卡住了"的结果，
    // 它会拿着半成品继续往下走。这类停止要按**失败**交回，并把已有产出一起附上。
    const STALL_STOP_REASONS = new Set(["plan_stale", "repeat_guard", "no_progress", "too_many_errors"]);
    if (endReason && STALL_STOP_REASONS.has(endReason)) {
      const zhs = getLang() === "zh";
      const note = zhs
        ? `[循环因「${endReason}」停止：这不是正常完成] 已调用工具 ${toolCallCount} 次。已产出的内容附在下方，请人工确认后再继续。`
        : `[Loop stopped due to "${endReason}": NOT a normal completion] ${toolCallCount} tool calls. Partial output below — verify before continuing.`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: note,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      recordLoopStop(sessionId, endReason === "plan_stale" ? "plan_stale" : "no_gain", {
        endReason,
        toolCalls: toolCallCount,
        partialOutputChars: cleanOutput.length,
      });
      if (delegationTaskId) {
        orchestrator.failTask(delegationTaskId, `${note}\n\n${zhs ? "已产出的内容" : "Partial output"}:\n${cleanOutput || "(none)"}`);
      }
      return { output: cleanOutput, toolCallCount, success: false, error: note };
    }

    // 通知编排器任务完成
    // 第 63 波（审计补）：被取消（用户点了终止 / 父会话 cancel_delegation）而 abort 掉的执行，
    // 不能在这里又报"完成" —— 否则取消会被收尾逻辑悄悄改回已完成。
    if (delegationTaskId) {
      if (abort.signal.aborted) {
        console.log(`[SessionExecutor] ${sessionId} 已中止，不再上报完成（委派任务保持 cancelled）`);
        orchestrator.cancelTask(delegationTaskId);
      } else {
        orchestrator.completeTask(delegationTaskId, cleanOutput || "[No output]");
      }
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
    // 第 64 波：看门狗必须释放（它持有定时器）
    watchdog.dispose();
    // 第 65 波：工具挂死上限 + 心跳也要清掉（否则任务结束后还会跑）
    clearToolFlight();
    clearInterval(flightHeartbeat);

    // 清理活跃执行追踪
    activeExecutions.delete(sessionId);

    // 标记会话为非活跃
    useAppStore.getState().setSessionActive(sessionId, false);

    // 如果是委派任务被 abort，标记为 cancelled
    // （但"空闲/预算中止"已经按失败落库，别覆盖成 cancelled）
    if (abort.signal.aborted && delegationTaskId && !watchdog.timedOut() && !abortedBy) {
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
