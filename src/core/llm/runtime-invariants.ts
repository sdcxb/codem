/**
 * Runtime Invariants — 运行时不变量
 *
 * 设计对标 DSH `runtime-diagnostics/invariants`。
 *
 * R3-3.6: "模型可见即已记录" 断言
 *
 * 核心不变量：任何出现在模型上下文中的消息必须在事件日志中有对应事件。
 * 如果违反（如消息被直接插入 DB 而未写事件日志），说明有 bug。
 *
 * 这是一个调试/开发工具 — 在生产环境中可以关闭（通过环境变量）。
 */

import { getEventLog } from "../storage/event-log";
import * as MessageStorage from "../storage/message";

// ========== Invariant Checking ==========

export interface InvariantViolation {
  type: string;
  message: string;
  sessionId?: string;
  messageId?: string;
  seq?: number;
}

export interface InvariantCheckResult {
  passed: boolean;
  violations: InvariantViolation[];
}

/**
 * R3-3.6: 检查"模型可见即已记录"不变量。
 *
 * 遍历所有会话，对每个会话：
 * 1. 从事件日志投影出消息列表
 * 2. 从消息存储读取消息列表
 * 3. 比较两者 — 任何差异都是违规
 *
 * 这个检查开销大，只在调试模式或 CI 中运行。
 *
 * ## 第 45 轮（功能上下文审计 §"未做"）：口径差必须消掉，否则这个断言**永远红**
 *
 * 原实现拿 `listMessages(sid)` 的**全部** id 去要求"每个 id 都有对应事件"，
 * 而事件写入点（`message.ts::appendMessageTextEvent`）**刻意**不写两种消息：
 *
 * 1. **纯工具轮的助手消息**（`content === ""`）：它的"事实"在 `tool_call` /
 *    `tool_result` 事件里，写一条空正文的 `assistant_text` 只会让投影多出一条空 assistant 行
 *    （理由写在 `appendMessageTextEvent` 的注释里，是**设计**而不是遗漏）；
 * 2. **流式中间态**（`status === "streaming"`）：不是定稿，等定稿那次落库才写事件。
 *
 * 于是"口径差"的形态是：这两类消息**合法地**没有文本事件，而原实现把它们全部
 * 报成 `VISIBLE_BUT_NOT_RECORDED`。后果比"多几条噪音"严重 —— 这个断言是
 * "事件双写到底通没通"（P0-D0）的**唯一自动判据**，而它恒红等于没有判据：
 * 真违规（有正文却没有事件）会被淹没在假违规里。
 *
 * 现在的判据（**收窄到"真的有正文的消息"**）：
 * - 有正文的用户/助手消息：必须能对上 `user_message` / `assistant_text` /
 *   `assistant_reasoning` 三种事件之一 —— 对不上就是**真违规**；
 * - **无正文的助手消息**：跳过（它的记录形式是工具事件，见
 *   `checkToolCallPairingInvariant` 与 `appendMessageTextEvent` 的边界说明）；
 * - 无正文的用户消息：仍然**必须**有 `user_message`（用户消息从不流式，
 *   也没有"纯工具轮的 user 消息"这种形态）—— 所以只跳过"无正文的 assistant"。
 *
 * ## `sessionIds` 参数（生产接线用）
 *
 * 原签名的 `sessionId?: string` 在**不给**参数时把 `sessions` 设成空数组
 * （"我们没有一个直接列出所有会话的方法"，见下面的注释），也就是
 * `runAllInvariants()` 无参调用**什么都检查不到却返回 passed: true**。
 * 生产侧（启动维护的 `auditInvariantsForSessions`）已经有会话列表，
 * 所以这里补一个显式入参：**给了就用，没给才回退** —— 语义是"要么检查这些会话，
 * 要么什么也不检查"，而不是"猜一批会话"（猜出来的会话集合会让判据本身不可信）。
 */
export function checkVisibleRecordedInvariant(
  sessionId?: string,
  sessionIds?: readonly string[],
): InvariantCheckResult {
  const violations: InvariantViolation[] = [];
  const eventLog = getEventLog();

  // 获取要检查的会话列表
  let sessions: string[];
  if (sessionId) {
    sessions = [sessionId];
  } else if (sessionIds && sessionIds.length > 0) {
    /*
     * 显式给了一批会话（生产接线走这条）：用它。
     * 去重 + 去掉空串，避免同一个会话被检查两遍而把违规条数翻倍。
     */
    sessions = [...new Set(sessionIds.filter((s) => typeof s === "string" && s.length > 0))];
  } else {
    // 获取所有有事件的会话 — 从事件日志推导
    // 注意：我们没有一个直接列出所有会话的方法，
    // 所以这里依赖消息存储
    sessions = [];
  }

  for (const sid of sessions) {
    // 从事件日志投影
    const projectedEvents = eventLog.readAll(sid);
    const projectedMessageIds = new Set<string>();
    /** 有 `tool_call` / `tool_result` 事件的消息 id（**纯工具轮助手消息的合法记录形式**） */
    const toolEventMessageIds = new Set<string>();
    for (const evt of projectedEvents) {
      if (evt.type === "tool_call" || evt.type === "tool_result") {
        const mid = (evt.payload as any)?.messageId;
        if (mid) toolEventMessageIds.add(String(mid));
      }
      if (evt.type === "user_message" || evt.type === "assistant_text" || evt.type === "assistant_reasoning") {
        const messageId = (evt.payload as any)?.messageId;
        if (messageId) projectedMessageIds.add(messageId);
      }
    }

    // 从消息存储读取
    const messages = MessageStorage.listMessages(sid);
    const storedMessageIds = new Set(messages.map((m: any) => m.id));

    // 检查：消息存储中有但事件日志中没有的
    for (const msg of messages as Array<{ id: string; role?: string; content?: string | null }>) {
      const msgId = String(msg.id);
      if (projectedMessageIds.has(msgId)) continue;
      /*
       * 口径收窄（见函数头）：无正文的助手消息**合法地**没有文本事件 ——
       * 它的事实是工具事件。**只有当那条工具事件也在**时才跳过；
       * 两者都没有（既无正文、又无工具事件）仍然算违规：一个既没正文
       * 也没任何事件记录的助手行，投影重建时一定会消失。
       */
      const hasText = typeof msg.content === "string" && msg.content.length > 0;
      if (!hasText && msg.role === "assistant") {
        if (toolEventMessageIds.has(msgId)) continue;
        violations.push({
          type: "VISIBLE_BUT_NOT_RECORDED",
          message:
            `Message ${msgId} 是无正文的 assistant 行，且事件日志里既没有文本事件也没有 tool_call/tool_result` +
            `（投影重建时这一行会消失）`,
          sessionId: sid,
          messageId: msgId,
        });
        continue;
      }
      violations.push({
        type: "VISIBLE_BUT_NOT_RECORDED",
        message: `Message ${msgId} exists in message storage but has no event in the event log`,
        sessionId: sid,
        messageId: msgId,
      });
    }

    // 检查：事件日志中有但消息存储中没有的（更宽松 — 可能是尚未投影）
    for (const msgId of projectedMessageIds) {
      if (!storedMessageIds.has(msgId as string)) {
        violations.push({
          type: "RECORDED_BUT_NOT_VISIBLE",
          message: `Message ${msgId} has an event in the log but is not in message storage (may be pending projection)`,
          sessionId: sid,
          messageId: msgId,
        });
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * R3-3.6: 检查工具调用配对完整性。
 *
 * 每个 tool_call 事件都应该有对应的 tool_result 事件。
 * 没有结果的 tool_call 是未完成的会话状态。
 */
export function checkToolCallPairingInvariant(sessionId: string): InvariantCheckResult {
  const violations: InvariantViolation[] = [];
  const events = getEventLog().readAll(sessionId);

  const pendingToolCalls = new Map<string, number>();

  for (const evt of events) {
    if (evt.type === "tool_call") {
      const toolCallId = (evt.payload as any)?.toolCallId;
      if (toolCallId) {
        pendingToolCalls.set(toolCallId, evt.seq);
      }
    }
    if (evt.type === "tool_result") {
      const toolCallId = (evt.payload as any)?.toolCallId;
      if (toolCallId) {
        pendingToolCalls.delete(toolCallId);
      }
    }
  }

  for (const [toolCallId, seq] of pendingToolCalls) {
    violations.push({
      type: "UNPAIRED_TOOL_CALL",
      message: `tool_call ${toolCallId} at seq ${seq} has no corresponding tool_result`,
      sessionId,
      seq,
    });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * 运行所有不变量检查。
 */
export function runAllInvariants(sessionId?: string): InvariantCheckResult {
  const violations: InvariantViolation[] = [];

  const visibleResult = checkVisibleRecordedInvariant(sessionId);
  violations.push(...visibleResult.violations);

  if (sessionId) {
    const pairingResult = checkToolCallPairingInvariant(sessionId);
    violations.push(...pairingResult.violations);
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
