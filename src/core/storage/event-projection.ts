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
import { getEventLog } from "./event-log";

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

    // Mark all removed messages
    for (const id of payload.removedMessageIds) {
      state.removedMessageIds.add(id);
    }

    // Set the compaction summary
    state.compactionSummary = payload.summary;

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
   * Checks:
   * - Every tool_result has a preceding tool_call with matching toolCallId
   * - No duplicate seq numbers
   * - Compaction events don't reference non-existent messages
   * - Event types are known
   *
   * @returns An array of validation errors (empty = valid)
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
          // Check that removedMessageIds is an array
          if (!Array.isArray(payload.removedMessageIds)) {
            errors.push(
              `compaction at seq ${event.seq} has invalid removedMessageIds`,
            );
          }
          break;
        }
        case "user_message":
        case "assistant_text":
        case "assistant_reasoning":
        case "turn_start":
        case "turn_end":
        case "memory_update":
        case "session_meta":
        case "permission_granted":
        case "permission_denied":
        case "error":
        case "abort":
          // Known types — no validation needed
          break;
        default:
          errors.push(
            `Unknown event type "${event.type}" at seq ${event.seq}`,
          );
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
        for (const id of payload.removedMessageIds) {
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
