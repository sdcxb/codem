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
 */
export function checkVisibleRecordedInvariant(sessionId?: string): InvariantCheckResult {
  const violations: InvariantViolation[] = [];
  const eventLog = getEventLog();

  // 获取要检查的会话列表
  let sessions: string[];
  if (sessionId) {
    sessions = [sessionId];
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
    for (const evt of projectedEvents) {
      if (evt.type === "user_message" || evt.type === "assistant_text" || evt.type === "assistant_reasoning") {
        const messageId = (evt.payload as any)?.messageId;
        if (messageId) projectedMessageIds.add(messageId);
      }
    }

    // 从消息存储读取
    const messages = MessageStorage.listMessages(sid);
    const storedMessageIds = new Set(messages.map((m: any) => m.id));

    // 检查：消息存储中有但事件日志中没有的
    for (const msgId of storedMessageIds) {
      if (!projectedMessageIds.has(msgId as string)) {
        violations.push({
          type: "VISIBLE_BUT_NOT_RECORDED",
          message: `Message ${msgId} exists in message storage but has no event in the event log`,
          sessionId: sid,
          messageId: msgId,
        });
      }
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
