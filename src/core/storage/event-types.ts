/**
 * Event Sourcing — Session Event Types
 *
 * Design (对标 DeepSeek Harness event-sourcing):
 * - Append-only event log: events are never deleted or updated
 * - Events are the source of truth; messages are derived projections
 * - Supports replay, fork, and projection
 *
 * Each event captures a discrete state transition in the conversation lifecycle.
 */

// ========== Event Types ==========

export type SessionEventType =
  | "user_message"      // User sent a message
  | "assistant_text"    // Assistant produced text content
  | "assistant_reasoning" // Assistant produced reasoning content
  | "tool_call"          // A tool was invoked
  | "tool_result"        // A tool returned a result
  | "compaction"         // Context compaction occurred (summary replaces old messages)
  | "turn_start"         // A new agentic turn began
  | "turn_end"           // An agentic turn completed
  | "memory_update"      // Memory was updated during the session
  | "session_meta"       // Session metadata changed (title, model, etc.)
  | "permission_granted" // User granted permission for a tool
  | "permission_denied"  // User denied permission for a tool
  | "error"              // An error occurred
  | "abort"              // Session was aborted
  ;

// ========== R3-3.1: Runtime Event Type Registry ==========
//
// DSH uses TypeScript declaration merging (SessionEventMap interface) to
// let plugins register custom event types at compile time. Since we don't
// use Cordis DI, we use a runtime registry instead: plugins call
// registerCustomEventType() at load time.

/** Built-in event types that cannot be overridden */
const BUILTIN_EVENT_TYPES = new Set<SessionEventType>([
  "user_message", "assistant_text", "assistant_reasoning",
  "tool_call", "tool_result", "compaction",
  "turn_start", "turn_end", "memory_update",
  "session_meta", "permission_granted", "permission_denied",
  "error", "abort",
]);

/** Registered custom event types */
const customEventTypes = new Map<string, { description?: string }>();

/**
 * Register a custom event type at runtime.
 * Plugins call this to declare events the event log should accept.
 * Cannot override built-in types.
 *
 * @param typeName The event type name (e.g. "feedback/record", "custom/my_event")
 * @param metadata Optional description
 * @throws if typeName collides with a built-in type
 */
export function registerCustomEventType(
  typeName: string,
  metadata?: { description?: string },
): void {
  if (BUILTIN_EVENT_TYPES.has(typeName as SessionEventType)) {
    throw new Error(
      `Cannot register custom event type "${typeName}" — it is a built-in type`,
    );
  }
  if (!customEventTypes.has(typeName)) {
    customEventTypes.set(typeName, metadata || {});
  }
}

/**
 * Check if a string is a valid (registered or built-in) event type.
 */
export function isValidEventType(typeName: string): boolean {
  return BUILTIN_EVENT_TYPES.has(typeName as SessionEventType) ||
    customEventTypes.has(typeName);
}

/**
 * List all registered custom event types.
 */
export function listCustomEventTypes(): string[] {
  return [...customEventTypes.keys()];
}

// ========== Event Payload Interfaces ==========

export interface UserMessagePayload {
  messageId: string;
  content: string;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    path?: string;
    preview?: string;
  }>;
}

export interface AssistantTextPayload {
  messageId: string;
  content: string;
  model?: string;
}

export interface AssistantReasoningPayload {
  messageId: string;
  content: string;
}

export interface ToolCallPayload {
  toolCallId: string;
  messageId: string;
  tool: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "error";
}

export interface ToolResultPayload {
  toolCallId: string;
  messageId: string;
  result?: string;
  error?: string;
  status: "completed" | "error";
  /** Persisted file path if the result was too large and stored to disk */
  persistedPath?: string;
}

export interface CompactionPayload {
  /** Message IDs that were removed */
  removedMessageIds: string[];
  /** Summary text that replaces the removed messages */
  summary: string;
  /** Number of messages before compaction */
  messagesBefore: number;
  /** Number of messages after compaction */
  messagesAfter: number;
}

export interface TurnStartPayload {
  iteration: number;
  assistantMessageId: string;
}

export interface TurnEndPayload {
  iteration: number;
  assistantMessageId: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
  };
  finishReason: string;
}

export interface MemoryUpdatePayload {
  memoryId: string;
  content: string;
  action: "add" | "update" | "delete";
}

export interface SessionMetaPayload {
  title?: string;
  model?: string;
  executionMode?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface ErrorPayload {
  message: string;
  code?: string;
  toolCallId?: string;
}

// ========== Event Interface ==========

export interface SessionEvent {
  /** Monotonic sequence number (auto-assigned by EventLog) */
  seq: number;
  /** Session this event belongs to */
  sessionId: string;
  /** Event type (built-in SessionEventType or a registered custom type string) */
  type: SessionEventType | string;
  /** Event payload (type-specific) */
  payload: Record<string, unknown>;
  /** Timestamp (ms since epoch) */
  timestamp: number;
}

// ========== Type Guard Helpers ==========

export function isUserMessage(e: SessionEvent): e is SessionEvent & { payload: UserMessagePayload } {
  return e.type === "user_message";
}

export function isAssistantText(e: SessionEvent): e is SessionEvent & { payload: AssistantTextPayload } {
  return e.type === "assistant_text";
}

export function isToolCall(e: SessionEvent): e is SessionEvent & { payload: ToolCallPayload } {
  return e.type === "tool_call";
}

export function isToolResult(e: SessionEvent): e is SessionEvent & { payload: ToolResultPayload } {
  return e.type === "tool_result";
}

export function isCompaction(e: SessionEvent): e is SessionEvent & { payload: CompactionPayload } {
  return e.type === "compaction";
}

// ========== R3-4.4: Type Safety Re-exports ==========
// Re-export assertNever + Branded types from type-safety module
// so they are available from the core types entry point.
export { assertNever, brand, unbrand, Branded, SessionId, ToolCallId, MessageId } from "../llm/type-safety";
