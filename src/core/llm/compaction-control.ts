/**
 * Compaction Control — 压缩精度控制 + 崩溃修复
 *
 * 设计对标 DSH `compaction/*` + `core/session` crash repair。
 *
 * R3-3.3: 压缩精度控制
 * - 工具配对边界检测（已有，增强为锁机制）
 * - 压缩锁：防止压缩期间并发修改
 * - 压缩边界必须落在 user/assistant 消息边界上
 *
 * R3-3.4: 崩溃修复
 * - 当会话在工具调用中间崩溃时，重启后需要修复不完整的工具调用
 * - TOOL_NOT_STARTED: 工具被调用但从未执行
 * - TOOL_OUTCOME_UNKNOWN: 工具执行了但结果未知（崩溃前未写入结果）
 */

import { getEventLog } from "../storage/event-log";
import type { SessionEvent, ToolCallPayload, ToolResultPayload } from "../storage/event-types";

// ========== R3-3.3: Compaction Lock ==========

/** 会话级压缩锁 — 防止并发压缩 */
const compactionLocks = new Set<string>();

/** 获取压缩锁。如果已被锁定，返回 false。 */
export function acquireCompactionLock(sessionId: string): boolean {
  if (compactionLocks.has(sessionId)) return false;
  compactionLocks.add(sessionId);
  return true;
}

/** 释放压缩锁。 */
export function releaseCompactionLock(sessionId: string): void {
  compactionLocks.delete(sessionId);
}

/**
 * 检查压缩边界是否安全 — 不在工具配对中间切割。
 *
 * 对标 DSH compaction boundary detection。
 * 边界必须落在：
 * - user 消息之后
 * - assistant 消息（及其所有工具调用+结果）之后
 *
 * 不能落在：
 * - tool_call 和 tool_result 之间
 * - assistant 消息的中间
 *
 * ## ⚠️ 生产路径上的真实消费者清单（第 47 轮 P2-D13：形参零使用的收口）
 *
 * 这个文件里两个"边界检查"函数的调用情况**必须说清楚**，因为原来不是：
 *
 * | 函数 | 生产消费者 | 说明 |
 * | --- | --- | --- |
 * | `acquireCompactionLock` / `releaseCompactionLock` | `agentic-loop.ts::compactMessages` | 真的在用（防并发压缩） |
 * | `repairCrashedSession` | `agentic-loop.ts:822` | **唯一的真消费者**：每次 `run()` 修崩溃遗留的未配对工具调用 |
 * | `isCompactionBoundarySafe` / `findSafeCompactionBoundary` | **无**（只有 `dsh-integration-full.test.ts` 的用例） | 见下 |
 *
 * `AgenticLoop.doCompactMessages` 原来把 `isCompactionBoundarySafe` 当**形参**收进去，
 * 函数体里从没用过它（`grep` 该标识符在函数体内零命中）—— 一个"看起来在做事件侧配对
 * 边界检查、实际什么都没做"的参数。**现在那个形参已删除**（`doCompactMessages(sessionId)`）。
 *
 * 为什么不是"真的在选点处调用它"：这条压缩路径工作在**消息**上
 * （`listMessages`→`foldStaleCompactionMarkers`→`alignKeepToRoundBoundary`），
 * 而 `isCompactionBoundarySafe(events, cutAtSeq)` 的入参是**事件 seq**。
 * 消息与事件之间没有可用的 seq 映射（`SessionEvent.seq` 是引擎侧的全局序号，
 * 消息行里不带它），硬接就得先猜一个 seq —— 那会让"边界安全"这个结论建立在猜测上，
 * 比不检查更糟。消息侧的轮次/工具配对对齐由 `alignKeepToRoundBoundary`
 * （`compaction-budget.ts:92`）负责，它按角色对齐，本来就不会切进 tool_result 中间。
 * 所以这里保留这两个**纯函数**（用例守着，未来事件侧压缩要接时是现成的判据），
 * 但如实标注"当前无生产消费者"。
 */
export function isCompactionBoundarySafe(
  events: SessionEvent[],
  cutAtSeq: number,
): { safe: boolean; reason?: string } {
  // 找到切割点之前最后一个事件和之后第一个事件
  const before = events.filter((e) => e.seq < cutAtSeq);
  const after = events.filter((e) => e.seq >= cutAtSeq);

  if (before.length === 0 || after.length === 0) {
    return { safe: false, reason: "empty before or after" };
  }

  // 检查是否有未配对的工具调用
  const pendingToolCalls = new Set<string>();
  for (const evt of before) {
    if (evt.type === "tool_call") {
      const payload = evt.payload as unknown as ToolCallPayload;
      pendingToolCalls.add(payload.toolCallId);
    }
    if (evt.type === "tool_result") {
      const payload = evt.payload as unknown as ToolResultPayload;
      pendingToolCalls.delete(payload.toolCallId);
    }
  }

  // 如果有未配对的工具调用在切割点之前，且结果在切割点之后
  if (pendingToolCalls.size > 0) {
    // 检查这些工具调用是否在 after 中有结果
    for (const evt of after) {
      if (evt.type === "tool_result") {
        const payload = evt.payload as unknown as ToolResultPayload;
        pendingToolCalls.delete(payload.toolCallId);
      }
    }
    if (pendingToolCalls.size > 0) {
      return {
        safe: false,
        reason: `unpaired tool calls: ${[...pendingToolCalls].join(", ")}`,
      };
    }
  }

  // 第一个 after 事件应该是 user_message 或 assistant_text（新轮的开始）
  const firstAfter = after[0];
  if (firstAfter.type !== "user_message" && firstAfter.type !== "assistant_text" && firstAfter.type !== "turn_start") {
    return {
      safe: false,
      reason: `boundary doesn't start at a message boundary (starts at ${firstAfter.type})`,
    };
  }

  return { safe: true };
}

/**
 * 找到安全的压缩边界 — 从目标位置向前搜索。
 */
export function findSafeCompactionBoundary(
  events: SessionEvent[],
  targetSeq: number,
): number {
  // 从目标位置向前搜索安全边界
  for (let seq = targetSeq; seq > 0; seq--) {
    const check = isCompactionBoundarySafe(events, seq);
    if (check.safe) return seq;
  }
  return 0; // 无法找到安全边界 — 不压缩
}

// ========== R3-3.4: Crash Repair ==========

/** 崩溃修复检测到的工具状态 */
type ToolCrashStatus = "TOOL_NOT_STARTED" | "TOOL_OUTCOME_UNKNOWN" | "TOOL_COMPLETE";

/** 崩溃修复结果 */
export interface CrashRepairResult {
  /** 修复的工具调用数 */
  repairedCount: number;
  /** 修复详情 */
  repairs: Array<{
    toolCallId: string;
    toolName: string;
    status: ToolCrashStatus;
    action: "synthesized_result" | "marked_as_unknown" | "no_action";
  }>;
}

/**
 * R3-3.4: 检测并修复崩溃后不完整的工具调用。
 *
 * 扫描事件日志，查找：
 * - TOOL_NOT_STARTED: tool_call 事件有，但没有任何执行记录
 * - TOOL_OUTCOME_UNKNOWN: tool_call 有且工具可能执行了，但没有 tool_result
 *
 * 对每个不完整的调用，合成一个结果事件：
 * - TOOL_NOT_STARTED → 合成 error 结果 "tool was not started (crash recovery)"
 * - TOOL_OUTCOME_UNKNOWN → 合成 error 结果 "tool outcome unknown (crash recovery)"
 *
 * 这样投影可以正确重建消息，不会留下悬挂的工具调用。
 */
export function repairCrashedSession(sessionId: string): CrashRepairResult {
  const log = getEventLog();
  const events = log.readAll(sessionId);

  const repairs: CrashRepairResult["repairs"] = [];
  const toolCalls = new Map<string, { seq: number; payload: ToolCallPayload }>();
  const toolResults = new Set<string>();

  // 第一遍：收集所有工具调用和结果
  for (const evt of events) {
    if (evt.type === "tool_call") {
      const payload = evt.payload as unknown as ToolCallPayload;
      toolCalls.set(payload.toolCallId, { seq: evt.seq, payload });
    }
    if (evt.type === "tool_result") {
      const payload = evt.payload as unknown as ToolResultPayload;
      toolResults.add(payload.toolCallId);
    }
  }

  // 第二遍：找出不完整的调用并修复
  for (const [toolCallId, { seq, payload }] of toolCalls) {
    if (toolResults.has(toolCallId)) continue; // 已有结果 — 跳过

    // 判断是 NOT_STARTED 还是 OUTCOME_UNKNOWN
    // 如果 tool_call 的 status 是 "pending"，则 NOT_STARTED
    // 如果是 "running"，则 OUTCOME_UNKNOWN
    let status: ToolCrashStatus;
    let action: CrashRepairResult["repairs"][0]["action"];

    if (payload.status === "pending") {
      status = "TOOL_NOT_STARTED";
      action = "marked_as_unknown";
    } else if (payload.status === "running") {
      status = "TOOL_OUTCOME_UNKNOWN";
      action = "synthesized_result";
    } else {
      // completed/error 但没有结果 — 异常状态
      status = "TOOL_OUTCOME_UNKNOWN";
      action = "synthesized_result";
    }

    // 合成一个 tool_result 事件
    const synthesizedResult: ToolResultPayload = {
      toolCallId,
      messageId: payload.messageId,
      status: "error",
      error: status === "TOOL_NOT_STARTED"
        ? "Tool was not started (crash recovery)"
        : "Tool outcome unknown (crash recovery)",
    };

    log.append(sessionId, "tool_result", synthesizedResult as unknown as Record<string, unknown>);

    repairs.push({
      toolCallId,
      toolName: payload.tool,
      status,
      action,
    });
  }

  return {
    repairedCount: repairs.length,
    repairs,
  };
}
