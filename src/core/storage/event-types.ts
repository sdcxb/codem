/**
 * Event Sourcing — Session Event Types
 *
 * Design (对标 DeepSeek Harness event-sourcing):
 * - Append-only log: events are never updated in place（唯一删事件的路径是
 *   `event-log.ts::compactWithSnapshot`，而它**没有生产调用者** —— 见该文件与本文件
 *   `session_snapshot` 处的说明）
 * - **消息才是权威，事件不是**（第 84 波改正，原话是反的）
 * - 支持 replay / projection / 结构自检
 *
 * ## 第 84 波（功能上下文审计 P5）：把"谁是谁的权威"写准
 *
 * 这里原来写的是 "Events are the source of truth; messages are derived projections"
 * —— **与实现相反**，而且这句话会直接误导读者判断"日志丢了能不能重建"：
 *
 * | 东西 | 谁是权威 | 证据 |
 * | --- | --- | --- |
 * | 消息 | `messages` 表，其权威副本是 **JSONL 追加日志**（SQLite 索引可重建） | `session-jsonl.ts:10-19`（"会话的权威存储是 append-only JSONL，SQLite 只是可重建的查询索引"）；读侧 `agentic-loop.ts:2853-2862` |
 * | 事件 | `session_events` **自身**（append-only，且**没有任何等价物、不可重建**） | `maintenance.ts:1223`（"`session_events` 是**唯一没有等价物**的存储"） |
 * | 投影 | 纯**派生读**（不写权威）；只供 telemetry / audit 与维护自检 | `event-projection.ts` 模块头（已改正） |
 *
 * 所以正确的不变量是：**消息可由 JSONL 重建，事件不能由任何东西重建**。
 * 本文件只负责**事件的类型集合**，不为消息的权威性背书。
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
  /**
   * 压缩**快照**（第 60 轮补进联合类型）。
   *
   * ## 这条类型字符串是**引擎钉死的线协议**，不是渲染侧的想象
   *
   * `src-tauri/codem-db/src/repo.rs::events_compact` 的 INSERT 里**字面写着**
   * `event_type = 'session_snapshot'`（锚点校验通过后 `INSERT OR REPLACE` 到锚点 seq 上，
   * 再删掉 cutoff 之前的非 meta 事件）。所以这个类型名一旦发出就无法改，
   * 渲染侧也必须在"已知类型集合"里认它。
   *
   * ## 但要说清今天它从哪里来（第 60 轮核实后的准确说法）
   *
   * 写路径 `event-log.ts::compactWithSnapshot` → `events.compact` 存在，投影
   * (`event-projection.ts::applySnapshot` / `case "session_snapshot"`) 也真的消费它；
   * 然而 `compactWithSnapshot` **目前没有生产调用者**（全仓只有测试调用）——
   * 启动维护刻意不做事件压缩，理由记在 `maintenance.ts::MaintenanceResult.prunedEvents`
   * 的长注释里。真机实测也一致：生产库 3112 条事件里 `session_snapshot` **0 条**。
   *
   * 那为什么还必须把它算作合法类型？因为它此前**不在**下面的 `BUILTIN_EVENT_TYPES` 里：
   * 于是 `isValidEventType("session_snapshot")` 返回 `false` ——
   * 而 `validateReplay` 的类型判据正是走这个函数，
   * 也就是"任何一条真实存在的快照事件都会被报成未知类型"（假报警），
   * 且引擎侧那个字面量会与渲染侧的类型集合长期不一致。
   * 这与 PortKind 里那个已不可达的 `"wasm"` 是同类问题：**类型在说谎**。
   *
   * 现在补上，并由 `event-type-set-consistency.test.ts` 守着"联合类型 ↔ 内建集合"不许再漂。
   */
  | "session_snapshot"
  | "turn_start"         // A new agentic turn began
  | "turn_end"           // An agentic turn completed
  | "memory_update"      // Memory was updated during the session
  | "session_meta"       // Session metadata changed (title, model, etc.)
  | "permission_granted" // User granted permission for a tool
  | "permission_denied"  // User denied permission for a tool
  | "error"              // An error occurred
  | "abort"              // Session was aborted
  /**
   * 执行轨迹的一步（第 68 轮补进权威集合）。
   *
   * ## 为什么必须在这里（真机取证）
   *
   * `core/provider/ui-trajectory-provider.ts` 用 `TRAJECTORY_EVENT_TYPE = 'trajectory_step'`
   * 把轨迹步骤批量写进 `session_events`，而这个名字**既不在内建集合里、也没人注册**。
   * 后果是真机控制台上：
   * ```text
   * [PersistFailure] maintenance.eventStructure 操作失败：事件库结构异常 7360 处
   * （样例：…: Unknown event type "trajectory_step" at seq 2643；…）
   * ```
   * 7360 条"结构异常"全部是**假报警** —— 事件是**唯一没有等价物**的存储，
   * 它的自检本来是最需要可信的信号，被这个噪声淹掉之后等于没有。
   * 而且这个"功能本次没有生效"的措辞还会误导用户以为自检没跑（实际跑了、报的是假问题）。
   *
   * ## 为什么当内建，而不是让插件自己注册
   *
   * 与 `session_snapshot` 同理：**写入方是一等公民代码**（不是第三方扩展点），
   * 而校验器可能在任何时刻被调用（维护、审计、回放）。把合法性挂在"插件加载顺序"上，
   * 就等于让"结构自检"的结果依赖于时序 —— 那是不可复现的判据。
   * 插件自定义类型仍走 `registerCustomEventType()`（第三方扩展点不变）。
   * 由 `event-type-write-sites.test.ts` 守着"写事件的地方用的类型名必须在集合里"。
   */
  | "trajectory_step"
  /**
   * 循环被停止（第 68 轮补进权威集合）。
   *
   * 写入方 `core/llm/loop-stop-log.ts`（"为什么这一轮停下了"的诊断日志），
   * 同一个门禁扫出来的第二个未注册类型 —— 它同样一直在被结构自检报成"未知事件类型"。
   */
  | "loop_stopped"
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
  // 第 60 轮补：引擎把它**字面写死**在 `repo.rs::events_compact` 的 INSERT 里，
  // 投影也在 `case` 它 —— 不在集合里就等于 `isValidEventType` 对真实快照事件说"不合法"。
  // （今天它没有生产写入者：维护刻意不压缩事件，实测生产库 0 条。见上面联合类型处的说明。）
  "session_snapshot",
  "turn_start", "turn_end", "memory_update",
  "session_meta", "permission_granted", "permission_denied",
  "error", "abort",
  // 第 68 轮补：两个**一等公民代码一直在写、却不在集合里**的类型。
  // 真机后果 = 7360 条假报警把结构自检变成噪声机（详见上面联合类型处的长注释）。
  "trajectory_step", "loop_stopped",
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

interface TurnStartPayload {
  iteration: number;
  assistantMessageId: string;
}

interface TurnEndPayload {
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

interface MemoryUpdatePayload {
  memoryId: string;
  content: string;
  action: "add" | "update" | "delete";
}

interface SessionMetaPayload {
  title?: string;
  model?: string;
  executionMode?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

interface ErrorPayload {
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

function isUserMessage(e: SessionEvent): e is SessionEvent & { payload: UserMessagePayload } {
  return e.type === "user_message";
}

function isAssistantText(e: SessionEvent): e is SessionEvent & { payload: AssistantTextPayload } {
  return e.type === "assistant_text";
}

function isToolCall(e: SessionEvent): e is SessionEvent & { payload: ToolCallPayload } {
  return e.type === "tool_call";
}

function isToolResult(e: SessionEvent): e is SessionEvent & { payload: ToolResultPayload } {
  return e.type === "tool_result";
}

function isCompaction(e: SessionEvent): e is SessionEvent & { payload: CompactionPayload } {
  return e.type === "compaction";
}

// ========== 完全重复的文本事件（O-29 / O-31 共用判据） ==========

/**
 * 只有这两种事件会被"完全重复"判据收敛。
 *
 * 为什么**只有**它们：`user_message` / `assistant_text` 不携带被别的行引用的 id。
 * `tool_call` / `tool_result` 靠 `toolCallId` 互相引用 —— 删掉较早的 `tool_call`
 * 会让配对的 `tool_result` 变成孤儿（`event-projection` 的结构检查会报
 * `references unknown toolCallId`）。所以哪怕载荷逐字节相同也**一概不动**。
 * 引擎侧 `events.dedup_text` 用的是同一份范围，改这里就必须同时改那边。
 */
export const DEDUPABLE_TEXT_EVENT_TYPES = ["user_message", "assistant_text"] as const;

/** 该事件是否属于"可去重的文本事件" */
export function isDedupableTextEvent(event: SessionEvent): boolean {
  return (DEDUPABLE_TEXT_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * 完全重复的判据：**同会话** + 同类型 + 载荷**逐字节**相同（不是"看起来像"）。
 *
 * `sessionId` 必须在键里：本函数是纯函数，"输入只有单个会话的事件"是**调用方**的约定
 * （`session_event_search` 只传一个会话的 `readAll` 结果）。把会话放进键里，
 * 万一有人把跨会话的数组丢进来，也只会**收敛不足**（少删几条），不会把
 * "两个会话里各自合法的那条正文"合并掉 —— 方向选对了，踩错也踩不坏。
 */
function exactDuplicateKey(event: SessionEvent): string {
  return `${event.sessionId}\u0000${event.type}\u0000${JSON.stringify(event.payload ?? null)}`;
}

/**
 * 把**完全重复**的文本事件收敛成一条：每组只保留 **`seq` 最小**的那条。
 *
 * ## 为什么是"最小"而不是"最新"（这条不能凭直觉定）
 *
 * `event-projection.ts` 的两条语义决定了它：
 * - `applyUserMessage`：`if (state.messages.some(m => m.id === payload.messageId)) return;`
 *   —— **首次写入胜出**，且该消息在派生列表里的**位置**由首次那条的 `seq` 决定；
 * - `applyAssistantText`：位置同样由**首次**那条决定（`push`），只有正文是后写覆盖。
 *
 * 本函数只收敛**载荷逐字节相同**的事件，所以正文保留哪条都一样；会被改变的是**位置**。
 * 保留 `seq` 最小者，"收敛前回放"与"收敛后回放"才会产出同一个消息序列
 * （`event-dedup.test.ts` 的 `DEDUP-3` 就钉这件事）。保留最新会把消息整体往后挪。
 *
 * ## 用途
 *
 * **读路兜底**：库里可能仍有 1.16.175 及更早版本留下的历史重复行
 * （真机实测：某会话 4842 条文本事件里只有 64 条不同）。维护命令
 * `events.dedup_text` 负责把存量删掉，而这个纯函数保证**在任何情况下**
 * 模型可见的搜索面都不会因为重复行给出重复命中 —— 即使维护还没跑、或将来又出了新的重复来源。
 *
 * 输入顺序被保留（只做删除，不重排）。
 */
export function collapseExactDuplicateTextEvents(events: SessionEvent[]): SessionEvent[] {
  const keepSeq = new Map<string, number>();
  for (const e of events) {
    if (!isDedupableTextEvent(e)) continue;
    const key = exactDuplicateKey(e);
    const prev = keepSeq.get(key);
    if (prev === undefined || e.seq < prev) keepSeq.set(key, e.seq);
  }
  return events.filter((e) => {
    if (!isDedupableTextEvent(e)) return true;
    return keepSeq.get(exactDuplicateKey(e)) === e.seq;
  });
}

// ========== R3-4.4: Type Safety Re-exports ==========
// Re-export assertNever + Branded types from type-safety module
// so they are available from the core types entry point.
export { assertNever, brand, unbrand, SessionId, ToolCallId, MessageId } from "../llm/type-safety";
export type { Branded } from "../llm/type-safety";
