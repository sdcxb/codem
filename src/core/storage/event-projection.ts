/**
 * Event Projection — Derive LLM-facing messages from the event log
 *
 * Design (对标 DeepSeek Harness projection):
 * - Pure function: events → LLM messages
 * - Supports incremental projection (only process new events)
 * - Handles compaction: when a compaction event is encountered,
 *   old messages are replaced with the summary
 *
 * The projection produces an array of LLMMessage objects suitable
 * for passing to the LLM API.
 */

import type { LLMMessage, LLMMessageRole, ContentBlock } from "../llm/types";
import type {
  SessionEvent,
  UserMessagePayload,
  AssistantTextPayload,
  AssistantReasoningPayload,
  ToolCallPayload,
  ToolResultPayload,
  CompactionPayload,
} from "./event-types";
// 值导入（不是 type）：`validateReplay` 的类型判据要用它
import { isValidEventType } from "./event-types";
import { getEventLog } from "./event-log";
// 载荷形状不合契约时如实上报（第 60 轮：不许静默容忍，也不许抛）
import { reportPersistFailure } from "./persist-failure";

// ========== Projection State ==========

interface ProjectionState {
  /** Messages accumulated so far */
  messages: LLMMessage[];
  /** Map from toolCallId → message index (for linking tool results) */
  toolCallIndex: Map<string, number>;
  /** The last compaction summary (replaces all previous messages) */
  compactionSummary: string | null;
  /** Set of message IDs removed by compaction */
  removedMessageIds: Set<string>;
  /** Last processed sequence number */
  lastSeq: number;
}

// ========== Projection Implementation ==========

export class EventProjection {
  /**
   * Project all events for a session into LLM messages.
   * This is the full projection — reads all events from the log.
   */
  projectAll(sessionId: string): LLMMessage[] {
    const events = getEventLog().readAll(sessionId);
    return this.projectFromEvents(events);
  }

  /**
   * Project events from a specific sequence number onward.
   * Used for incremental projection after the initial build.
   *
   * Note: Compaction events invalidate the previous state, so
   * incremental projection after a compaction requires a full rebuild.
   */
  projectIncremental(
    sessionId: string,
    fromSeq: number,
    previousMessages: LLMMessage[],
    previousToolCallIndex: Map<string, number>,
  ): LLMMessage[] {
    const events = getEventLog().readFrom(sessionId, fromSeq);

    // If any compaction event exists in the new events, do a full rebuild
    const hasCompaction = events.some(e => e.type === "compaction");
    if (hasCompaction) {
      return this.projectAll(sessionId);
    }

    // Incremental: continue from previous state
    const state: ProjectionState = {
      messages: [...previousMessages],
      toolCallIndex: new Map(previousToolCallIndex),
      compactionSummary: null,
      removedMessageIds: new Set(),
      lastSeq: fromSeq - 1,
    };

    for (const event of events) {
      this.applyEvent(state, event);
    }

    return state.messages;
  }

  /**
   * Project from a pre-loaded array of events.
   * Useful for testing and replay scenarios.
   */
  projectFromEvents(events: SessionEvent[]): LLMMessage[] {
    const state: ProjectionState = {
      messages: [],
      toolCallIndex: new Map(),
      compactionSummary: null,
      removedMessageIds: new Set(),
      lastSeq: 0,
    };

    for (const event of events) {
      this.applyEvent(state, event);
    }

    // If there was a compaction, prepend the summary as the first message
    if (state.compactionSummary) {
      const summaryMsg: LLMMessage = {
        id: "compaction-summary",
        role: "system",
        content: `[Previous conversation summary]\n\n${state.compactionSummary}`,
      };
      return [summaryMsg, ...state.messages];
    }

    return state.messages;
  }

  /**
   * Apply a single event to the projection state.
   */
  private applyEvent(state: ProjectionState, event: SessionEvent): void {
    state.lastSeq = event.seq;

    switch (event.type) {
      // 第 77 波：快照事件 —— 让"裁剪事件日志"变成**安全**操作。
      //
      // 背景：事件日志被投影当状态读取，所以按 seq 截断会让投影缺段（上一波审计因此把
      // 事件裁剪默认关掉了）。正确做法是先把投影状态**固化成一个事件**，再丢掉它之前的
      // 事件：回放 = 快照 + 其后的事件，结果与完整回放一致（有 replay 等价性用例守着）。
      case "session_snapshot":
        this.applySnapshot(state, event);
        break;
      case "user_message":
        this.applyUserMessage(state, event);
        break;
      case "assistant_text":
        this.applyAssistantText(state, event);
        break;
      case "assistant_reasoning":
        this.applyAssistantReasoning(state, event);
        break;
      case "tool_call":
        this.applyToolCall(state, event);
        break;
      case "tool_result":
        this.applyToolResult(state, event);
        break;
      case "compaction":
        this.applyCompaction(state, event);
        break;
      case "turn_start":
      case "turn_end":
      case "memory_update":
      case "session_meta":
      case "permission_granted":
      case "permission_denied":
      case "error":
      case "abort":
        // These event types don't produce messages in the projection
        // They are metadata events used for replay, telemetry, etc.
        break;
    }
  }

  /**
   * 应用快照事件：用快照里的状态**替换**当前投影状态。
   *
   * 为什么是"替换"而不是"合并"：快照是 compaction 之前所有事件的压缩结果，
   * 它出现在日志中就意味着那些事件**已经被删除**；回放 = 快照 + 其后的事件。
   * 若此处做合并，被删事件留下的残留会与快照叠加，出现重复消息。
   */
  private applySnapshot(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as {
      messages?: LLMMessage[];
      compactionSummary?: string | null;
      removedMessageIds?: string[];
      atSeq?: number;
    };
    state.messages = Array.isArray(payload.messages) ? payload.messages.map((m) => ({ ...m })) : [];
    state.compactionSummary = payload.compactionSummary ?? null;
    state.removedMessageIds = new Set(payload.removedMessageIds ?? []);
    // 重建工具调用索引，保证后续 tool_result 仍能挂到对应的 assistant 消息上
    state.toolCallIndex = new Map();
    state.messages.forEach((m, idx) => {
      const calls = (m as any).tool_calls;
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          if (tc?.id) state.toolCallIndex.set(tc.id, idx);
        }
      }
    });
  }

  private applyUserMessage(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as UserMessagePayload;

    // Skip if this message was removed by compaction
    if (state.removedMessageIds.has(payload.messageId)) return;

    // Dedup: skip if a message with the same ID was already projected
    // (defensive guard against duplicate events in the log)
    if (state.messages.some(m => m.id === payload.messageId)) return;

    state.messages.push({
      id: payload.messageId,
      role: "user",
      content: payload.content,
    });
  }

  private applyAssistantText(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as AssistantTextPayload;

    // Skip if removed by compaction
    if (state.removedMessageIds.has(payload.messageId)) return;

    // Try to find an existing assistant message with the same ID (for streaming updates)
    const existing = state.messages.find(m => m.id === payload.messageId);
    if (existing) {
      // Update content (streaming append)
      if (typeof existing.content === "string") {
        existing.content = payload.content;
      }
    } else {
      state.messages.push({
        id: payload.messageId,
        role: "assistant",
        content: payload.content,
      });
    }
  }

  private applyAssistantReasoning(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as AssistantReasoningPayload;

    if (state.removedMessageIds.has(payload.messageId)) return;

    // Find the assistant message and attach reasoning
    const existing = state.messages.find(m => m.id === payload.messageId);
    if (existing && typeof existing.content === "string") {
      // Convert to content blocks if needed
      const blocks: ContentBlock[] = [
        { type: "text", text: existing.content },
        { type: "text", text: `[Reasoning]\n${payload.content}` },
      ];
      existing.content = blocks as any;
    }
  }

  private applyToolCall(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as ToolCallPayload;

    if (state.removedMessageIds.has(payload.messageId)) return;

    // Find or create the assistant message that contains this tool call
    let assistantMsg = state.messages.find(m => m.id === payload.messageId);
    if (!assistantMsg) {
      assistantMsg = {
        id: payload.messageId,
        role: "assistant",
        content: "",
      };
      state.messages.push(assistantMsg);
    }

    // Add tool_use content block to the assistant message
    if (typeof assistantMsg.content === "string") {
      assistantMsg.content = [{ type: "text", text: assistantMsg.content }];
    }
    const blocks = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    // Check if this tool call already exists (dedup)
    const existingTc = blocks.find(b => b.type === "tool_use" && b.id === payload.toolCallId);
    if (!existingTc) {
      blocks.push({
        type: "tool_use",
        id: payload.toolCallId,
        name: payload.tool,
        input: payload.args as Record<string, unknown>,
      });
    }
    assistantMsg.content = blocks;

    // Track the index for linking tool results
    state.toolCallIndex.set(payload.toolCallId, state.messages.indexOf(assistantMsg));
  }

  private applyToolResult(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as ToolResultPayload;

    if (state.removedMessageIds.has(payload.messageId)) return;

    // Dedup: skip if a tool result with the same toolCallId was already projected
    const toolResultId = `tool-result-${payload.toolCallId}`;
    if (state.messages.some(m => m.id === toolResultId)) return;

    // Create a tool message with the result
    const toolMessage: LLMMessage = {
      id: toolResultId,
      role: "tool",
      toolCallId: payload.toolCallId,
      content: payload.result || payload.error || "",
    };

    state.messages.push(toolMessage);
  }

  private applyCompaction(state: ProjectionState, event: SessionEvent): void {
    const payload = event.payload as unknown as CompactionPayload;

    /**
     * ## 第 60 轮：**载荷形状不对时不许抛**（真机数据逼出来的）
     *
     * 真机取证：用第 60 轮刚接上的结构自检扫用户真实库，报出
     *
     * ```text
     * 1788268497135-31x6vdt97: compaction at seq 2230 has invalid removedMessageIds
     * ```
     *
     * 读那一行：`{"markerId":"compact-…-repair47","reason":"…","summary":"…"}`
     * —— 它是**第 47 轮审计修复脚本**补写的一条汇总 marker（生产写入方
     * `agentic-loop.ts:3417` 写的是规范的 `{removedMessageIds, summary, messagesBefore, messagesAfter}`），
     * 也就是**历史遗留的另一种形状**。
     *
     * 而这里原来直接 `for (const id of payload.removedMessageIds)` ——
     * 对 `undefined` 做 `for…of` 会 **TypeError**。这条投影路径接在
     * `agentic-loop.ts:1279`（每轮拼 surface notice）、`surface-manager`、
     * `validateReplay` 上，且**外面没有 try/catch**：
     * 于是"库里有一条形状不认识的历史 compaction 行"就等于
     * **那个会话一开口就抛**。用户库里正好有这么一条，这条修复是把潜在故障拆掉，
     * 而不是把判据放宽 —— `validateReplay` 依然会如实报出这行不合契约。
     *
     * 判据用 `Array.isArray`（而不是 `?? []`）：`null` / 字符串 / 对象都拦得住，
     * `?? []` 只挡 `undefined`/`null`。
     */
    const removed = Array.isArray(payload?.removedMessageIds) ? payload.removedMessageIds : [];
    if (!Array.isArray(payload?.removedMessageIds)) {
      reportPersistFailure(
        "eventProjection.compaction",
        new Error(`compaction 事件载荷缺少 removedMessageIds 数组（seq=${event.seq}）`),
        "该条压缩事件的形状不合契约（历史遗留 / 修复脚本写过别的形状）：本次按「不删除任何消息」处理，" +
          "以免投影整体抛错；存储自检会在维护里报出这一行",
      );
    }

    // Mark all removed messages
    for (const id of removed) {
      state.removedMessageIds.add(id);
    }

    // Set the compaction summary
    if (typeof payload?.summary === "string") {
      state.compactionSummary = payload.summary;
    }

    // Filter out removed messages from the current state
    state.messages = state.messages.filter(m => !state.removedMessageIds.has(m.id));

    // Clear tool call index for removed messages
    const newToolCallIndex = new Map<string, number>();
    for (const [tcId, idx] of state.toolCallIndex) {
      if (idx < state.messages.length) {
        newToolCallIndex.set(tcId, idx);
      }
    }
    state.toolCallIndex = newToolCallIndex;
  }

  // ========== R3-2.3: Replay Validation ==========

  /**
   * R3-2.3: Validate that an event log replays without structural errors.
   *
   * Checks (与实现逐条对齐 —— 原注释有三条对不上，见下面的修正):
   * - Every tool_result has a preceding tool_call with matching toolCallId
   * - No duplicate seq numbers
   * - Compaction events carry a `removedMessageIds` array
   * - Event types are known (authoritative set, see below)
   *
   * ## 第 60 轮的修正（三处，都是"注释比实现说得多"）
   *
   * 1. **类型判据改用权威集合**（原来是硬编码 switch，而且已经漂了）。
   *    原实现列了一串 `case "user_message": case "assistant_text": …` 当"已知类型"，
   *    而那份清单**缺 `session_snapshot`** —— 引擎把它字面写在
   *    `repo.rs::events_compact` 的 INSERT 里（见 `event-types.ts` 的说明），
   *    投影也真的 `case` 它。也就是说：这份校验只要被调用，就会把**合法快照**
   *    报成 `Unknown event type "session_snapshot"` —— 一个"假报警机器"。
   *    现在判据来自 `isValidEventType()`（内建集合 + 已注册自定义类型，唯一真源）；
   *    它自己的漂移由 `event-type-set-consistency.test.ts` 守着
   *    （解析 `event-types.ts` 的联合类型与内建集合，断言两者一致）。
   *
   * 2. **快照边界上的工具配对**：快照意味着"它之前的事件已被删除、状态固化在这条事件里"，
   *    所以配对集合必须**按快照重建**（和 `applySnapshot` 重建 `toolCallIndex` 同一个道理）。
   *    不重建的话，`tool_call` 在快照里、`tool_result` 在快照之后的**正常日志**
   *    会被报成 `references unknown toolCallId` —— 又一处假报警。
   *
   * 3. **原注释说"Compaction events don't reference non-existent messages"，实现里没有这条**。
   *    这里**不补**成错误判据，而是把话说准：`removedMessageIds` 里的 id
   *    完全可能**在事件日志里从来找不到** —— 那正是压缩的语义（那些事件已被删掉），
   *    加上维护删行留下的永久 seq 空洞（实测生产库 3112 条事件、364 个空洞）。
   *    把它当错误就是把正常库判成坏库，所以只校验载荷形状。
   *    （对照：`repo.rs::events_compact` 在**写入**侧才要求锚点事件真实存在。）
   */
  validateReplay(sessionId: string): string[] {
    const events = getEventLog().readAll(sessionId);
    const errors: string[] = [];
    const seenSeqs = new Set<number>();
    const pendingToolCalls = new Set<string>();

    for (const event of events) {
      // Check for duplicate seq
      if (seenSeqs.has(event.seq)) {
        errors.push(`Duplicate seq: ${event.seq}`);
      }
      seenSeqs.add(event.seq);

      switch (event.type) {
        case "session_snapshot": {
          /*
           * 快照 = "之前的事件已经没有了，状态在这条里"。配对待挂集合按快照重建
           * （先清空再装载），与 `applySnapshot` 重建 `toolCallIndex` 的语义一致。
           */
          pendingToolCalls.clear();
          const payload = event.payload as unknown as {
            messages?: Array<{ tool_calls?: Array<{ id?: string }> }>;
          };
          if (Array.isArray(payload.messages)) {
            for (const m of payload.messages) {
              if (!Array.isArray(m?.tool_calls)) continue;
              for (const tc of m.tool_calls) {
                if (tc?.id) pendingToolCalls.add(tc.id);
              }
            }
          }
          break;
        }
        case "tool_call": {
          const payload = event.payload as unknown as ToolCallPayload;
          pendingToolCalls.add(payload.toolCallId);
          break;
        }
        case "tool_result": {
          const payload = event.payload as unknown as ToolResultPayload;
          if (!pendingToolCalls.has(payload.toolCallId)) {
            errors.push(
              `tool_result at seq ${event.seq} references unknown toolCallId: ${payload.toolCallId}`,
            );
          }
          // Remove from pending (a call can have only one result)
          pendingToolCalls.delete(payload.toolCallId);
          break;
        }
        case "compaction": {
          const payload = event.payload as unknown as CompactionPayload;
          // 只校验载荷形状（为什么不校验"引用的消息是否存在"见上面第 3 条）
          if (!Array.isArray(payload.removedMessageIds)) {
            errors.push(
              `compaction at seq ${event.seq} has invalid removedMessageIds`,
            );
          }
          break;
        }
        default:
          /*
           * 类型判据来自**权威集合**（内建 + 已注册自定义类型），不再维护第二份清单：
           * 原来这里是一串硬编码 `case`，而且已经漂了 —— 缺 `session_snapshot`
           * （引擎字面写入、投影也 `case` 的类型），于是会把合法快照报成未知类型。
           */
          if (!isValidEventType(String(event.type))) {
            errors.push(`Unknown event type "${event.type}" at seq ${event.seq}`);
          }
      }
    }

    // Unresolved tool calls (call without result) are a warning, not error
    if (pendingToolCalls.size > 0) {
      // This is OK during an active session — the call is still in progress
    }

    return errors;
  }

  /**
   * R3-2.3: Project the "surface" — the current visible state of the session.
   *
   * The surface is the set of messages the model would see right now,
   * after applying all events including compaction.
   * This is the same as projectAll, but also returns metadata about
   * what was compacted/removed.
   */
  projectSurface(sessionId: string): {
    messages: LLMMessage[];
    totalEvents: number;
    compactedMessageIds: string[];
    lastSeq: number;
  } {
    const events = getEventLog().readAll(sessionId);
    const state: ProjectionState = {
      messages: [],
      toolCallIndex: new Map(),
      compactionSummary: null,
      removedMessageIds: new Set(),
      lastSeq: 0,
    };

    for (const event of events) {
      this.applyEvent(state, event);
    }

    // Build final messages with compaction summary prepended
    let messages = state.messages;
    if (state.compactionSummary) {
      const summaryMsg: LLMMessage = {
        id: "compaction-summary",
        role: "system",
        content: `[Previous conversation summary]\n\n${state.compactionSummary}`,
      };
      messages = [summaryMsg, ...messages];
    }

    return {
      messages,
      totalEvents: events.length,
      compactedMessageIds: Array.from(state.removedMessageIds),
      lastSeq: state.lastSeq,
    };
  }

  // ========== R3-3.2: Generation Tracking + replaceGeneration ==========

  /**
   * R3-3.2: Track "generations" — each assistant message is a generation.
   *
   * A generation = one assistant response (may contain text + tool calls).
   * When a generation is replaced (e.g. by compaction or user edit),
   * its events remain in the log but are marked as superseded.
   *
   * This method returns the current active generation's seq range.
   */
  getActiveGenerations(sessionId: string): Array<{
    messageId: string;
    startSeq: number;
    endSeq: number;
    isSuperseded: boolean;
  }> {
    const events = getEventLog().readAll(sessionId);
    const generations: Array<{
      messageId: string;
      startSeq: number;
      endSeq: number;
      isSuperseded: boolean;
    }> = [];

    let currentGen: { messageId: string; startSeq: number } | null = null;
    const supersededMessages = new Set<string>();

    for (const event of events) {
      // Track compaction to mark superseded messages
      if (event.type === "compaction") {
        const payload = event.payload as unknown as CompactionPayload;
        // 形状不对时按"没有删除任何消息"处理（理由见 `applyCompaction`：真机库里
        // 存在历史遗留的 compaction 形状，抛错会让整个投影调用失败）
        const removed = Array.isArray(payload?.removedMessageIds) ? payload.removedMessageIds : [];
        for (const id of removed) {
          supersededMessages.add(id);
        }
      }

      if (event.type === "assistant_text" || event.type === "assistant_reasoning") {
        const payload = event.payload as unknown as AssistantTextPayload;
        if (!currentGen || currentGen.messageId !== payload.messageId) {
          if (currentGen) {
            generations.push({
              ...currentGen,
              endSeq: event.seq - 1,
              isSuperseded: supersededMessages.has(currentGen.messageId),
            });
          }
          currentGen = { messageId: payload.messageId, startSeq: event.seq };
        }
      }
    }

    // Close last generation
    if (currentGen) {
      generations.push({
        ...currentGen,
        endSeq: events.length > 0 ? events[events.length - 1].seq : currentGen.startSeq,
        isSuperseded: supersededMessages.has(currentGen.messageId),
      });
    }

    return generations;
  }

  /**
   * R3-3.2: Replace a generation — mark an assistant message as superseded
   * by appending a compaction event that removes it.
   *
   * This doesn't delete events from the log (append-only), but marks the
   * generation as no longer active in the surface projection.
   */
  replaceGeneration(
    sessionId: string,
    messageId: string,
    replacementSummary?: string,
  ): void {
    getEventLog().append(sessionId, "compaction", {
      removedMessageIds: [messageId],
      summary: replacementSummary || "(generation replaced)",
      messagesBefore: 1,
      messagesAfter: 0,
    });
  }
}

// ========== Singleton Access ==========

let projectionInstance: EventProjection | null = null;

export function getEventProjection(): EventProjection {
  if (!projectionInstance) {
    projectionInstance = new EventProjection();
  }
  return projectionInstance;
}

// ========== Convenience Functions ==========

/**
 * Derive LLM messages from the event log for a session.
 * This is the primary function used by buildMessages() in agentic-loop.
 */
export function deriveMessagesFromEvents(sessionId: string): LLMMessage[] {
  return getEventProjection().projectAll(sessionId);
}
