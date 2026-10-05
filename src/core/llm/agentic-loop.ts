import type { LLMProvider, LLMRequest, ToolDefinition, TokenUsage } from "./types";
import type { ToolRegistry, ToolContext, WriteConfirmResult } from "./tools";
import type { PlanUpdateOp } from "./plan-utils";
import { applyPlanUpdate as applyPlanUpdatePure, looksLikeExecutableTask, renderPlanSection } from "./plan-utils";
import { foldStats, renderFoldSummary, isFoldMessage, pruneStaleToolResults } from "./context-fold";
/**
 * 第 122 轮 B 项：把「这一轮丢了什么上下文」投给界面。
 * 三处剥离/折叠原来只写 `console.warn`（`3138`/`3142`/`3161`），
 * 模型少了半截上下文而用户一无所知 —— 归因必然是「模型不行」。
 */
import { recordContextDrop } from "./context-visibility";
import type { ToolExecutorConfig } from "./streaming-executor";
import { StreamingToolExecutorImpl, type StreamingToolCall } from "./streaming-executor";
import { initDefaultPipeline } from "./tool-pipeline";
// 契约谓词：快照判据从这里来，不在调用点自己拼条件（那样又会长出第二处真相）
import { mutatesWorkspace, needsPreCallSnapshot } from "./tool-contract";
import { RetryExecutor, classifyError, logRetry } from "../retry/retry";
import { getTokenTracker, estimateTokens, estimateToolDefinitionTokens } from "./token-tracker";
import { extractJSON } from "./output-parser";
import { getGuidanceQueue, GUIDANCE_MESSAGE_TEMPLATE, type GuidanceItem } from "./guidance-queue";
import { getNeedsYouQueue } from "./needs-you-queue";
import { tryGetCtx } from "../consumer/index.ts";
import { AgentMessageQueue } from "./agent-message-queue";
import { getPermissionManager, type PermissionRequest, type PermissionResult } from "../permission/permission";
import { getVisionProxy } from "./vision-proxy";
import { getSnapshotService } from "../snapshot/snapshot";
import { debugLog, warnOnce } from "../debug";
import { buildFamilyReminder } from "./task-keyword-search";
import { RepeatGuard, type GuardKind, bashIntent } from "./loop-guard";
import { StallGuard } from "./stall-guard";
import { buildUnparsableArgsError, buildTruncatedToolCallError, isContentBearingTool } from "./tool-args-guard";
import { classifyToolResult } from "./tool-result-status";
import { recordLoopStop } from "./loop-stop-log";
import { isContextOverflowError, describeContextOverflow } from "./provider-errors";
import { planCompactionKeep, alignKeepToRoundBoundary, foldStaleCompactionMarkers, isCompactionMarker, nextCompactionMarkerId, selectMessagesByPriority } from "./compaction-budget";
import { isSandboxAclEnabled } from "../sandbox/sandbox-acl";
import { ArtifactTracker } from "./artifact-tracker";
import { getDelegationOrchestrator } from "../session/orchestrator";
import * as MessageStorage from "../storage/message";
// deriveMessagesFromEvents removed — DB CRUD is the single source of truth for LLM messages
import { getEventLog } from "../storage/event-log";
import { getTelemetry } from "../telemetry/telemetry";
import { evaluateWithSecurityMode } from "../permission/security-mode";
import { FileChangeTracker } from "../environment/file-change-tracker";
import { TranscriptCache } from "../storage/transcript-cache";
import { tryAutoCommit } from "../environment/git-commit-service";

// ========== Agentic Loop Types ==========
export type LoopResult =
  | {
      type: "stop";
      reason: string;
      usage: TokenUsage;
      /**
       * 停止原因的量级细节（可选）。
       *
       * 第 93 波新增：`plan_stale` 这条停止原因**必须在界面上有独立终态**
       * （"因停滞而停止，请人工确认下一步"），而呈现层要能说清停在哪一档，
       * 就需要把 `stalledFor` 这类数字带出去 —— 否则界面只能给一句空话。
       */
      detail?: Record<string, unknown>;
    }
  | { type: "overflow"; message: string; usage: TokenUsage }
  | { type: "aborted" }
  | { type: "error"; error: string };

// ========== P1 Feature Types ==========

/** Clarification form structure for AI to ask structured questions */
export interface ClarificationFormData {
  question: string;
  type: "radio" | "checkbox" | "text";
  options?: string[];
  required: boolean;
  formId: string;
}

/** Todo item for todo list tracking */
export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  order: number;
}

export interface LoopState {
  iteration: number;
  /**
   * Hard iteration cap (0 = no cap). Only used as a runaway safety valve,
   * NOT as a normal stop condition. The loop stops when the model produces
   * no tool calls (natural completion), matching DSH's "no built-in turn
   * budget" design.
   * Sub-agents set a finite cap to prevent recursive runaway.
   */
  maxIterations: number;
  totalUsage: TokenUsage;
  toolCallsInIteration: number;
  consecutiveErrors: number;
  lastError?: string;
  contextPressure: number;
  isCompacting: boolean;
  /** True if compaction happened during the current iteration (prevents premature stop) */
  compactedThisIteration: boolean;
  /** Count of consecutive compactions to prevent infinite loops */
  consecutiveCompactions: number;
  /** P0-3: True if micro-compact has been applied in this run (prevents re-compacting) */
  microCompactedThisRun: boolean;
  /** E8: True if cost degradation has been activated (switched to cheaper model) */
  costDegraded: boolean;
  /** S4: True if a write confirmation was rejected by the user — stops the loop to prevent retries */
  writeRejected: boolean;
  /**
   * Runaway detection: consecutive iterations with tool calls but zero
   * effective progress (no text output AND no new tool results). If this
   * reaches MAX_NO_PROGRESS, the loop stops to prevent infinite loops.
   * Reset whenever the model produces text or a tool returns new output.
   */
  consecutiveNoProgress: number;
  /** 第 68 波：最近一次迭代的 provider 结束原因（截断判定要用；executeIteration 写入） */
  lastFinishReason: string;
  /** 第 69 波：本轮正文输出了多少字符（0 = 只有思考、没有正文；用于区分两种截断） */
  lastIterationTextChars: number;
  /**
   * 本迭代 **LLM 调用最终失败**的原因（重试已耗尽 / 不可重试的 4xx），否则 `null`。
   *
   * ## 为什么必须有这个字段（假成功：LLM 失败被报成 completed）
   *
   * `executeIteration` 的 catch 一旦失败就 `consecutiveErrors++` 然后 `return` ——
   * 于是**永远走不到** `this.state.toolCallsInIteration = currentToolCalls.length` 那一行。
   * 主循环看到 `toolCallsInIteration === 0`，把它当成"模型这一轮没有调用工具 ⇒ 自然结束"，
   * 返回一个 `type: "stop"` 且 **reason 为 completed** 的结果：一次硬失败（400/500、重试耗尽）
   * 对调用方**和正常完成长得一模一样**（真机表现：用户发一条消息，没有任何回复，
   * 界面却说"完成"；用量面板也记成成功）。
   *
   * 判据只在**最终失败**时置位（内层重试成功的尝试不置位 —— 那正是重试的意义），
   * 并在每个迭代开头清空，绝不从第 N 轮泄漏到第 N+1 轮。
   */
  lastIterationError: string | null;
  /** Turn start timestamp — set at the beginning of each run() for duration tracking */
  turnStartTime?: number;
}

export interface LoopConfig {
  /**
   * Hard iteration cap (0 = no cap, default). Only used as a runaway safety
   * valve — the loop stops naturally when the model produces no tool calls.
   * Sub-agents set a finite cap to prevent recursive runaway.
   */
  maxIterations: number;
  /**
   * Model context window (tokens). Synced into TokenTracker so
   * context-pressure estimation uses the real window instead of the
   * 128k default — otherwise 1M-window models compact after ~3 turns.
   */
  contextWindow?: number;
  /** Agent ID for this loop — used for tool filtering and message routing */
  agentId?: string;
  /** Tool allowlist from agent definition — if set, only these tools are available */
  toolAllowlist?: string[];
  maxConsecutiveErrors: number;
  enableCompaction: boolean;
  compactionThreshold: number;
  enableReactiveCompaction: boolean;
  enablePermissions: boolean;
  maxOutputTokens: number;
  temperature: number;
  model?: string;
  toolExecutor?: Partial<ToolExecutorConfig>;
  /** Called when a tool needs user permission. Return the user's decision. */
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResult>;

  // ===== Phase 0 新增字段（以下字段暂不使用，为后续 Phase 预留） =====

  /** (E2) Reasoning effort level passed to LLMRequest */
  reasoningEffort?: "low" | "medium" | "high";

  /** (F1.2) Called after context compaction completes, for triggering memory extraction */
  onCompactionComplete?: () => void;

  /** (F1.3) Called after each turn completes, for triggering memory extraction */
  onTurnComplete?: (usage: TokenUsage) => void;

  /** (F1.2/F1.3) Whether automatic memory extraction is enabled */
  memoryEnabled?: boolean;

  /** (E8) Cost tracker instance for cost-aware degradation */
  costTracker?: import("./cost-tracker").CostTracker;

  /** (E8) Cost warning threshold (0-1, default 0.8). When session cost reaches this fraction of the limit, degrade to cheaper model. */
  costWarningThreshold?: number;

  /** (E8) Hard stop threshold (0-1, default 1.0). When session cost reaches this fraction of the limit, stop the loop. */
  costStopThreshold?: number;

  /** (M1) Resolve a task slot to a provider + model for that slot. Returns null to use loop default. */
  resolveProvider?: (slot: string) => { provider: LLMProvider; model: string; temperature?: number } | null;

  /** (C1) Collaboration mode: "default" = autonomous, "plan" = read-only planning */
  collaborationMode?: import("../agent/agent").CollaborationMode;

  /** Security mode: "ask" = confirm everything, "auto" = auto-approve safe ops, "full" = never ask */
  securityMode?: "ask" | "auto" | "full";

  /** (S1) Called before overwriting an existing file. Return accept/reject/custom instruction. */
  onWriteConfirm?: (params: {
    filePath: string;
    existingContent: string;
    newContent: string;
  }) => Promise<WriteConfirmResult>;

  // ===== Phase D extensions =====

  /** (D2) Get the current system prompt. Returns the assembled prompt string. */
  getSystemPrompt?: () => string;
  /** (D2) Submit prompt changes for user review. */
  onPromptChangeSubmit?: (changes: import("./tools").PromptChange[]) => Promise<{ applied: boolean; message: string }>;
  /** (D3) Present an interactive form to the user and wait for their response. */
  onInteractiveForm?: (questions: import("./tools").InteractiveFormQuestion[]) => Promise<Record<string, unknown>>;

  // ===== Phase F extensions =====

  /** (F5) Active notebook ID — when set, enables notebook knowledge mode */
  notebookId?: string;

  /**
   * 本轮助手消息 id 的**落库方**（第 154 轮，O-28）。
   *
   * ## 为什么必须有这个回调（真机取证：微信回合的 3 条"看得见但没入日志"）
   *
   * 助手消息的**行 id 是落库方生成的**：界面路径在 `App.tsx` 生成
   * （`assistant-${Date.now()}[-迭代号]`），后台路径（委派 / 微信桥 / 手机续聊）
   * 在 `executor.ts` 生成 —— 两侧都写进 `messages` 表，也都会写进
   * `tool_calls.message_id`。
   *
   * 而引擎里一直有**自己的一套 id**（本文件 run() 开头的 `msg-${Date.now()+1}`，
   * 以及每轮末的 `msg-${…+iteration+100}`），它只喂给 `ToolContext.messageId`。
   * 于是 `EventLogFinalizeMiddleware` 写下的 `tool_call` / `tool_result` 事件里，
   * `messageId` 是引擎自造的 `msg-…` —— **在 `messages` 表里根本不存在这一行**。
   *
   * 真机现场（1.16.152，`wx-…-im-wechat` 会话，副本库实测）：
   * ```text
   * messages 行            tool_calls.message_id     事件里的 messageId
   * assistant-1790319154162  assistant-1790319154162  msg-1790319153390   ← 对不上
   * assistant-1790319155690-2 assistant-1790319155690-2 msg-1790319155791 ← 对不上
   * assistant-1790319157180-3 assistant-1790319157180-3 msg-1790319157282 ← 对不上
   * ```
   * 后果有两层：① 纯工具轮的助手行（正文为空，**设计上**不写 `assistant_text`，
   * 靠工具事件记账）在维护自检里被判 `VISIBLE_BUT_NOT_RECORDED`（真机报"本次新产生 3 条"）；
   * ② 更要紧的是**投影重建**：`event-projection.applyToolCall` 找不到那个 id 就
   * **凭空建一条 `msg-…` 的助手行**，真实行反而消失 —— 事件日志与消息存储从此对不上。
   *
   * ## 契约
   *
   * - 回调应返回**当前这一轮助手消息在消息存储里的真实 id**；落库方还没建行时
   *   **按需建行**并返回其 id（executor 侧的 `ensureAssistantMessage()` 就是这个语义）；
   * - 返回空串 / 未接线 / 抛错 → 退回落库方缺省行为（引擎自造的 `msg-…`）；
   * - 每个迭代**只问一次**（构建工具上下文时），所以落库方可以放心地在这里建行。
   */
  resolveAssistantMessageId?: (sessionId: string) => string | undefined;
}

/**
 * Consecutive iterations with tool calls but zero progress (no text output
 * and no new tool results) before the loop is stopped as a runaway safety valve.
 * Matches DSH's philosophy: let the model work as long as it's making progress,
 * but stop if it's stuck in a loop.
 *
 * DSH has NO token budget cap and NO iteration cap on the main loop — it only
 * stops on natural completion (no tool calls) or user abort. We align with this:
 * the main loop runs indefinitely as long as the model is making progress.
 * The no-progress valve is the sole runaway protection for the main loop.
 * 30 iterations is generous enough for complex multi-step tasks while still
 * catching genuine infinite loops.
 */
/** 轻量包装：避免为了判一次类型而把 loop-guard 的完整意图对象搬进来 */
function bashIntentKind(command: string): "enumerate" | "mutate" | "other" {
  return bashIntent(command).kind;
}

/**
 * 摘要输入里「单条消息」的字符上限。
 *
 * 原来这里是 500 / 200 字硬截断 —— 等于让摘要只读得到每条消息的**开头**。
 * 长编码任务里那基本等于「没看到任务」：摘要一丢状态，之后模型就会重复劳动，
 * 甚至把已经改好的东西再改回去。**摘要是长会话里唯一的记忆**，不能这样喂。
 * 现在放宽到「够用但有界」，并且截断时**必须明说**（见 boundOne）。
 */
const LLMEngineTextBounds = {
  USER: 8000,
  ASSISTANT: 8000,
  TOOL_ARGS: 2000,
  TOOL_RESULT: 4000,
} as const;

/**
 * 这条命令算不算「验证」。
 *
 * 目的是把"改了文件"和"证明改动是对的"分开：**光写不算完成**，要跑过测试/构建/类型检查才算。
 * 判据刻意放宽（宁可多认几个），因为它只用来**提醒**与**标注**，不用来拦截任何操作。
 */
export function looksLikeVerificationCommand(command: string): boolean {
  const c = String(command ?? "");
  if (!c.trim()) return false;
  if (/(^|[\s&|;(])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest|build|lint|typecheck|check|tsc)\b/i.test(c)) return true;
  if (/(^|[\s&|;(])(npx\s+)?(vitest|jest|mocha|pytest|tsc|eslint|biome|ruff|mypy)\b/i.test(c)) return true;
  if (/(^|[\s&|;(])(go\s+test|cargo\s+(test|check|build)|dotnet\s+(test|build))\b/i.test(c)) return true;
  if (/\bnode\s+--test\b/i.test(c)) return true;
  if (/\bpython\s+-m\s+(pytest|unittest)\b/i.test(c)) return true;
  return false;
}

/** 单条消息的截断：保留头部 + 明确写出省略了多少字符（不许静默截断）。导出供判据直接钉。 */
export function boundOne(text: string, cap: number): string {
  const s = String(text ?? "");
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…（本条消息过长，已省略 ${s.length - cap} 个字符）`;
}

/** 摘要输入的整体上限（字符）。60000 ≈ 15k token，比原来的 12000 宽 5 倍且仍有界。 */
const SUMMARY_CONVERSATION_CHAR_CAP = 60000;

/**
 * 摘要输入的整体边界。
 *
 * ⚠️ 这里修的是一个**方向性**错误：原来超过 12000 字符就 `substring(0, 12000)`，
 * 也就是**保留最旧的、丢掉最新的**。而在一个编码任务里，最新的上下文恰恰最该进摘要
 * （刚跑完的测试输出、刚改的文件、刚犯的错）。现在**同时保留头与尾**，并把省略量写在中间 ——
 * 与 DSH 的 `buildSummarizationInput` 同取向（它直接重放真实消息，不做全局砍尾）。
 */
export function boundConversationForSummary(text: string, cap: number = SUMMARY_CONVERSATION_CHAR_CAP): string {
  const s = String(text ?? "");
  if (s.length <= cap) return s;
  const headLen = Math.floor(cap * 0.4);
  const tailLen = cap - headLen;
  const omitted = s.length - cap;
  return (
    s.slice(0, headLen) +
    `\n…（中间省略了 ${omitted} 个字符的对话；下面是最近的上下文）\n` +
    s.slice(s.length - tailLen)
  );
}

const MAX_CONSECUTIVE_NO_PROGRESS = 30;

/**
 * 第 68 波：因**单次输出上限**被截断时，最多自动续写几次。
 *
 * 真实事故：用户说"继续之前没完成的任务"，一轮就结束了（被截断的纯文本回复被当成写完了）。
 * 自动续写能让截断变成"可恢复"；但也不能无限续（否则一个写不完的任务会一直烧钱），
 * 所以给 3 次预算，用完就明确停下并告诉用户该怎么改（分块写入 / 调大上限）。
 */
const MAX_TRUNCATED_CONTINUATIONS = 3;

/**
 * 时间上下文的刷新间隔（毫秒）—— 与 DSH `context/time-context` 的默认值一致。
 *
 * 为什么必须节流（第？波，前缀缓存/成本）：注入文本里带**秒级**时间戳，
 * 不节流就等于"每次准备回合都产生一段新文本"。它现在虽然只出现在尾部消息里
 * （不破坏稳定前缀），但没有必要每轮都重新告诉模型"现在几点" ——
 * `buildTimeContext` 的 `refreshIntervalMs = 0` 是"不节流"，正是本条要改掉的默认。
 */
const TIME_CONTEXT_REFRESH_INTERVAL_MS = 600_000;


const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 0,
  contextWindow: 128000,
  maxConsecutiveErrors: 3,
  enableCompaction: true,
  compactionThreshold: 0.8,
  enableReactiveCompaction: true,
  enablePermissions: true,
  maxOutputTokens: 4096,
  temperature: 0.7,
  // Phase 0 新增默认值
  memoryEnabled: false,
  collaborationMode: "default",
};

/** P0-3: Minimum message count before micro-compact kicks in */
const KEEP_RECENT_MESSAGES_FOR_MICRO_COMPACT = 12;

/**
 * P0-3: Pressure threshold for micro-compact (proportion of context window).
 * Below this, context is healthy — keep full tool results.
 * DSH-aligned: cheap pruning first, full compaction only as a last resort.
 */
const MICRO_COMPACT_PRESSURE_THRESHOLD = 0.5;

/**
 * 第 83 波：整段压缩时**最少保留多少条**消息。
 *
 * 保留集本身要参与"能否装进窗口"的判定（见 doCompactMessages 的按体积收缩）：
 * 一条消息都不留会让模型完全失去正在进行的上下文，所以留个下限，
 * 到这个下限还超预算就如实上报（单条消息本身超窗口，压缩救不了）。
 */
const MIN_KEEP_MESSAGES = 4;

/**
 * 宏观步骤对齐：recon（只读侦查）工具名 + 计划元操作，不推进宏步骤计数器
 * macro step counter. They are intermediate investigation steps, not
 * top-level task phases.
 */
export const RECON_TOOL_NAMES = new Set<string>([
  "read", "read_file", "read_attachment",
  "glob", "grep", "grep_search", "file_search", "search_code", "codebase_search",
  "tool_search", "web_search", "list_directory", "list_sessions",
  "lsp", "session_search", "session_trace", "get_goal", "job_list",
  "search_notebook", "query_session_result", "list_agents", "list_sessions",
  // 计划元操作：修改计划本身不是"执行一个任务步骤"，不推进 X/X。
  "update_plan",
]);

export interface StepPlan {
  title: string;
}

/** 截取任务消息前 N 个字符作为启发式兜底步骤的标题摘要。 */
function taskBrief(message: string, max: number): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export type LLMStatus = "connecting" | "streaming" | "executing_tools";

export type LoopEvent =
  | { type: "start"; iteration: number }
  | { type: "llm_status"; status: LLMStatus }
  | { type: "step_progress"; step: number; total: number | null; title: string; steps: StepPlan[] | null }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "knowledge_sources"; sources: Array<{ sourceId: string; sourceName: string; chunkIndex: number; snippet: string; score: number }> }
  | { type: "tool_start"; toolCall: StreamingToolCall }
  | { type: "tool_complete"; toolCall: StreamingToolCall; result: any }
  | { type: "tool_error"; toolCall: StreamingToolCall; error: string }
  | { type: "permission_request"; request: PermissionRequest; resolve: (result: PermissionResult) => void }
  | { type: "compaction_start" }
  | { type: "compaction_end"; messagesRemoved: number }
  | { type: "retry"; attempt: number; delay: number; error: string; errorType: string | null }
  | { type: "usage"; usage: TokenUsage }
  | { type: "guidance_received"; message: string; guidanceId: string }
  // P1: Clarification form event — AI asks user a structured question
  | { type: "clarification"; form: ClarificationFormData; resolve: (answers: string[]) => void }
  // P1: Correction mode event — fact-check result ready for comparison
  | { type: "correction_complete"; original: string; corrected: string; changes: string[] }
  // P1: Pipeline step event — a pipeline step completed
  | { type: "pipeline_step_complete"; stepId: string; stepTitle: string; result: string }
  // P1: Todo list event — AI created a todo list for the user
  | { type: "todo_list_created"; todoId: string; todos: TodoItem[] }
  // P0: File changes tracked — per-turn git tree diff captured
  | { type: "file_changes_tracked"; artifactId: string; changedFiles: Array<{ path: string; status: string }>; turnIndex: number }
  // P1: Needs You — Agent proactively pauses and asks user a precise question
  | { type: "needs_you"; question: string; context: string; confirmedFacts: string; options: Array<{ id: string; label: string }>; itemId: string }
  // P2: Agent Message — async inter-agent communication received
  | { type: "agent_message_received"; fromAgent: string; subject: string; body: string }
  | { type: "end"; result: LoopResult };

// ========== Agentic Loop ==========
/**
 * **收尾时"还有红的测试"最多提醒几次**（第 128 波，值是**实测逼出来的**）。
 *
 * 245 的读数里，repo-10 与 repo-06 各有一轮是**在提醒之后仍然收尾**而结束的 ✗ ——
 * `loopStops` 明确记着 phase=red-test-nudge / reason=completed_unverified ✓，
 * 而且那两轮改动量偏小（831 / 2957 字符 ✗，通过那轮 3329 ✓）。原来这里是"只提醒一次"✗
 * ⇒ 提醒完它就停了 ✗。现在放到 2 ✓：仍然**有界** ✓（判据 RT-3/RT-4 钉住"最多 2 次、之后必须放行" ✓）。
 */
const RED_TEST_NUDGE_LIMIT = 2;

/**
 * 一回合里最多为几个文件给「同族判据」那条事实（第 133 波）。
 *
 * 取 4 的理由：既不会因为「第一次编辑恰好没有同族判据」而整回合作废 ✓（那正是 repo-02 波动的原因 ✗），
 * 又仍然**有界** ✓ —— 每多一个文件就是一次 grep（IPC 调用 ✓），不能无限 ✓。
 */
const SYMBOL_SIBLINGS_MAX_PER_TURN = 4;

export class AgenticLoop {
  private provider: LLMProvider; // E8: not readonly — can be swapped during cost degradation
  private tools: ToolRegistry;
  private executor: StreamingToolExecutorImpl;
  private retryExecutor: RetryExecutor;
  private config: LoopConfig;
  private state: LoopState;
  private abortController: AbortController | null = null;
  private currentSnapshotId: string | null = null;
  private lastCwd: string = "";

  /**
   * 已经收到过"工作区测试文件清单"的会话（第 94 波）。
   * 每个会话只注入一次：清单本身是常量，重复注入只会白烧 token ✗。
   */
  private testFileNoticeSent = new Set<string>();

  /**
   * 第 109 波：本回合是否已经补发过「判据族提醒」。
   * 每回合只补一次 —— 提示本身是常量，重复投放只会白烧 token ✗。
   */
  private familyReminderSentInTurn = false;

  /**
   * 第 125/133 波：本回合**已经为哪些文件**给过「同族判据」那条事实 ✓。
   *
   * ⚠️ 第 133 波从「每回合一个布尔」改成「按文件记」✗→✓，依据是真机日志：
   * `symbol siblings: null | edited= src/core/llm/index.ts` —— 机制触发了 ✓，
   * 但那个文件里的符号没有任何判据提到 ⇒ 返回 null ✗，而布尔标记已经把本回合**唯一**的机会
   * 用掉了 ✗ ⇒ 之后它去改 `tools.ts`（那里正有 `dsh-d9` 的符号）也不会再提示 ✗。
   * 这正是 repo-02 轮间波动的来源 ✓。
   */
  private symbolSiblingsSentFor = new Set<string>();

  /** 本回合的用户消息（补发提醒时要用它做相关性排序；第 109 波） */
  private lastUserMessage = "";
  // State-based tool deduplication — no timers, no thresholds
  // Tracks what files have been read/written in the CURRENT user request.
  // Reset at the start of each run() call (new user message = new task).
  private readCache: Map<string, { offset: number; limit: number; lineNumbers: boolean; output: string }> = new Map();   // path → last read content (range **和** 是否带行号)
  /** 宏观步骤计数器（1-based）。侦查类工具不推进它。 */
  private macroStep = 1;
  /** First execution tool seen in the current iteration (used to advance macroStep once per iteration). */
  private lastExecToolInIteration: string | null = null;
  /** Last execution tool name (for step title fallback). */
  private lastExecToolName = "";
  /** 计划耗尽后追加的步骤标题（去重）。宏观计划步语义：只有出现新的执行类别时才追加一次，且总数受限。 */
  private appendedStepTitles: Set<string> = new Set();
  /** 计划耗尽后最多追加的步骤数 — 防止「无用步数」无限膨胀。 */
  private static readonly MAX_APPENDED_STEPS = 2;
  /**
   * 当前对话任务的语义计划（"第X/X步"数据源，对标 dsh 客户端 todo 语义步骤）。
   * run() 每次调用重置。update_plan 工具通过 applyPlanUpdate 修改它。
   * fromLlm=true 表示计划由 LLM 生成（语义步骤）：耗尽后引擎不再自动追加
   * 泛化标题步骤（如"执行命令"），避免污染语义列表 —— 模型应通过 update_plan
   * 插入语义步骤；fromLlm=false（启发式兜底）保留旧的自动追加行为。
   */
  private activePlan: { plan: StepPlan[] | null; total: number | null; fromLlm: boolean } = { plan: null, total: null, fromLlm: false };
  /** update_plan 修改计划后置位；run() 事件循环据此推送一次刷新 step_progress。 */
  private planDirty = false;
  private writeCache: Map<string, string> = new Map();  // path → last written content
  /**
   * DSH-style: settlement 通过 Promise 网关注入。
   * 不再用轮询检查 task 状态、不注入提醒消息。
   * SubagentRuntime 在 dispose 时通过 settlementGate resolve Promise，
   * agentic-loop 在 stop 条件处 await 这个 Promise，settlement 到达后
   * 通知已写入 DB，下一轮 buildMessages 自然看到。
   */
  private pendingBackgroundSubagents: Map<string, Promise<void>> = new Map();
  /** settlement 到达时的外部 resolver，供 runtime 调用 */
  private settlementResolvers: Map<string, () => void> = new Map();
  /** 已 settled 的子智能体 ID — 由 resolveSubagentSettlement 填充 */
  private settledSubagentIds: Set<string> = new Set();
  // 保留旧字段以兼容旧代码引用，但不再用于逻辑控制。
  /** @deprecated 旧模式遗留 — 不再用于逻辑控制 */
  private waitedSubagents: Map<string, string> = new Map();
  /** @deprecated 旧模式遗留 — 不再用于逻辑控制 */
  private spawnedSubagents: Set<string> = new Set();
  // Cross-session delegation tracking (same pattern as subagent tracking)
  private delegatedTasks: Set<string> = new Set(); // delegation task IDs (not yet waited on)
  private waitedDelegations: Map<string, string> = new Map(); // delegation taskId → cached result
  /**
   * 第 64 波：每个委派任务"上一次查看时子会话的进度"以及"连续几次查看之间没有新进展"。
   * 判据是**两次查看之间子会话有没有动**（信息增益），不是"看了几次"。
   */
  private delegationProgressAtWait: Map<string, string> = new Map();
  private delegationStuckPeeks: Map<string, number> = new Map();
  /**
   * 第 62 波：重复工具调用守卫。
   *
   * 事故：交接后的新会话连续几十次枚举同一个目录（只换装饰性开关），一路走到父会话等待超时。
   * 既有的两道阀门都拦不住 —— 每次都"成功返回结果"所以算有进展，同轮次去重又不覆盖 bash。
   * 守卫按「精确指纹 + 只读枚举意图指纹」识别原地打转：提醒 → 抑制 → 停。
   */
  private repeatGuard: RepeatGuard = new RepeatGuard();
  /**
   * 第 65 波：计划停滞检测 —— 补上「每次输出都不一样但任务一步没走」的空转。
   * 判据与内容无关：**计划指纹没变 + 没产出交付物 + 没获得新信息**；先问（注入聚焦问题）再停。
   * （"没获得新信息"是第 93 波的治本修正，见 `stall-guard.ts` 头部 —— 只认写盘会把
   *  大仓库里的逐文件探索误杀在第 24 轮。）
   */
  private stallGuard: StallGuard = new StallGuard();
  /**
   * **最近一次"跑测试"的结果**（第 108 波）。
   *
   * 为什么需要它（有一手证据，不是想当然）：真实评测里有一轮，
   * agent 跑了 `usage-normalize.test.ts` 等三个文件，输出 **4 failed**（其中就有最后让它
   * 没过的判据），它还专门 `git stash` 回基线复跑确认同样红 —— 然后只跑了另一组绿的
   * （9 passed）就收工，回执写"已完成"。**它看见了红，还是把红说成了完成。**
   *
   * 这里只做一件事：记住"最近一次跑测试红了几条"，供收尾时判"这轮不许就这么结束"。
   */
  private lastTestRun: { command: string; failed: number; passed: number; redFiles: string[] } | null = null;
  /**
   * **本轮跑过的测试文件 → 最近一次已知状态**（第 109 波修正）。
   *
   * 为什么不能只看"最近一次运行"（这是实测抓到的模型误判）：有一轮的真实序列是
   *
   *   ① 本次任务的判据文件 → **4 failed**（红）
   *   ② 同两个文件再跑 → **4 failed**（红）
   *   ③ 回基线复跑 → **4 failed**（红）
   *   ④ 换一组**别的**文件跑 → **9 passed**（绿）
   *   ⑤ 收工，回执写"已完成"
   *
   * 只看"最近一次"就会看到 ④ 的绿 ⇒ 守卫沉默，而这恰恰是要抓的那次失败。
   * **正确口径是按文件记账**：某个文件红过、之后又没有单独跑绿，它就还是红的
   * （④ 跑的是另一组文件，不能给 ①②③ 里那两个文件洗白）。
   */
  private testFileStatus = new Map<string, "red" | "green">();
  /** 本轮因"收尾时测试还红着"提醒过几次（上限 1，避免把模型困在循环里） */
  private redTestNudges = 0;

  /**
   * 读"最近一次跑测试的结果"（第 108 波）。
   *
   * 刻意包一层方法：直接读字段会被 TypeScript 的控制流分析收窄成 `null`
   * （本轮重置处的赋值在同一函数内可见），于是收尾守卫那段代码会被判成 `never`。
   */
  private currentTestRun(): { command: string; failed: number; passed: number; redFiles: string[] } | null {
    return this.lastTestRun;
  }

  /**
   * 识别"这一次调用是在跑测试"，并把它红了几条记下来（第 108 波）。
   *
   * 判据刻意**保守**：只有命令里真的出现测试运行器（`vitest` / `jest` / `pytest` /
   * `npm test` / `cargo test` …）才算，免得把 `grep vitest` 这类命令的输出误当成测试结果
   * （判据误报的代价是"明明没跑测试却被要求解释红"，比漏报更烦人）。
   */
  private noteTestRun(name: string, args: Record<string, unknown>, rawOutput: string): void {
    const command = String((args as any)?.command ?? (args as any)?.code ?? "");
    if (!command) return;
    /**
     * **先剥掉 ANSI 颜色**（第 111 波）。
     *
     * 评测 harness 里不会有颜色（实测 12/12 份真实判据输出都不含 ANSI），但**交互使用**时
     * 有的运行器会带颜色，逐文件标记行会变成 `\u001b[31m❯\u001b[39m src/test/x.test.ts` ——
     * 我那条 `([❯✓×])\s+(文件)` 的正则就匹配不到，"红的是哪个文件"**静默失效**
     * （机制变死代码，而所有判据仍然全绿）。剥掉转义码零成本、严格更好。
     */
    const output = rawOutput.replace(/\u001b\[[0-9;]*m/g, "");
    // 真的"调用"了运行器（行首/分隔符之后），而不是提到它的名字
    const invokesRunner =
      /(^|[\s;&|])(npx\s+|pnpm\s+|yarn\s+)?(vitest|jest|pytest|mocha)\b/.test(command) ||
      /(^|[\s;&|])(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(command) ||
      /(^|[\s;&|])cargo\s+test\b/.test(command);
    if (!invokesRunner) return;
    if (!/^(bash|run_code|workflow|pwsh)$/.test(name)) return;

    /**
     * 解析条数：**先认汇总行**（vitest 的 `Tests  4 failed | 8 passed`），再退回任意 `N failed`。
     *
     * 为什么顺序重要（第一版就是这里错的）：逐文件行也会出现 `(4 tests | 1 failed)`，
     * 直接 `/(\d+)\s+failed/` 会先匹配到**文件级的 1**，于是提醒里说"1 条失败"，
     * 与真实情况（4 条）不符 —— 提醒里的数字错了，模型就会被误导。
     */
    const failedMatch = output.match(/\bTests\s+(\d+)\s+failed/i) ?? output.match(/(\d+)\s+failed/i);
    const passedMatch = output.match(/\bTests\s+(\d+)\s+passed/i) ?? output.match(/(\d+)\s+passed/i);
    /**
     * 失败数优先取显式数字（vitest：`Tests  4 failed | 8 passed`）；
     * 没有数字但输出里有 `FAILED`/`failed` 时按 1 条算（cargo/pytest 的风格），
     * 而 `0 failed` 必须算 0（否则"全绿"会被判成红）。
     */
    let failed = failedMatch ? Number(failedMatch[1]) : 0;
    if (!failedMatch && /(^|\s)(FAILED|FAIL)\b/m.test(output) && !/\b0\s+failed/i.test(output)) failed = 1;
    const passed = passedMatch ? Number(passedMatch[1]) : 0;
    // 先记一个初值（redFiles 在下面按文件记账之后再补全）
    this.lastTestRun = { command: command.replace(/\s+/g, " ").slice(0, 200), failed, passed, redFiles: [] };

    /**
     * **按文件记账**（第 109 波修正，见 `testFileStatus` 的字段注释）。
     *
     * 优先用逐文件标记行判每个文件的红绿（vitest 会打 `❯ path (4 tests | 1 failed)` /
     * `✓ path (4 tests)`）；标记行拿不到时（输出被截断/换行形态不同）退回保守口径：
     * 这次命令里点到的文件，只要这次运行有失败，就都按红算 —— 宁可多问一句，
     * 也不要漏掉"红过又没复跑绿"的文件。
     */
    const filesInCommand = [...command.matchAll(/[\w./\\-]+\.(?:test|spec)\.(?:ts|tsx|js|mjs)/g)].map((m) =>
      m[0].replace(/\\/g, "/").replace(/^.*?\/(?=[^/]+$)/, ""),
    );
    const markerRe = /([❯✓×])\s+([^\s(]+\.(?:test|spec)\.(?:ts|tsx|js|mjs))/g;
    const marked = new Set<string>();
    for (const m of output.matchAll(markerRe)) {
      const file = m[2].replace(/\\/g, "/").split("/").pop() as string;
      marked.add(file);
      this.testFileStatus.set(file, m[1] === "✓" ? "green" : "red");
    }
    if (marked.size === 0 && filesInCommand.length > 0) {
      for (const file of new Set(filesInCommand)) {
        this.testFileStatus.set(file, failed > 0 ? "red" : "green");
      }
    } else if (failed > 0) {
      // 有失败但只认出了部分文件：把命令里点到的、没被标记过的也算红（保守）
      for (const file of new Set(filesInCommand)) {
        if (!marked.has(file) && this.testFileStatus.get(file) !== "green") this.testFileStatus.set(file, "red");
      }
    }

    /**
     * **把"这次红的是哪些文件"记下来，供结果里附一句指向**（第 111 波）。
     *
     * 证据（第 110 波实测，四个失败任务**全零**）：agent 会跑红的那条判据，
     * 却**从不读它**（读的都是自己觉得相关的其它判据）⇒ 不知道期望的语义 ⇒ 照着症状猜着改
     * （只补了报错路径的一条分支、规格里要求的几种状态没做全）。
     *
     * 光在提示词里写"要读测试"是**希望**；这里是**机制**：红的那一刻，把文件路径直接递到它眼前。
     */
    this.lastTestRun = {
      command: this.lastTestRun?.command ?? command.replace(/\s+/g, " ").slice(0, 200),
      failed,
      passed,
      redFiles: [
        ...new Set([
          ...[...marked].filter((f) => this.testFileStatus.get(f) === "red"),
          ...filesInCommand.filter((f) => this.testFileStatus.get(f) === "red"),
        ]),
      ],
    };
  }

  /** 本轮"跑过且最近一次是红的"测试文件（第 109 波：按文件记账，不是只看最近一次运行） */
  private currentRedTestFiles(): string[] {
    return [...this.testFileStatus.entries()].filter(([, status]) => status === "red").map(([file]) => file);
  }

  /**
   * 计划修订号：**只在模型成功调用 update_plan 时 +1**（第 65 波）。
   * 刻意不用 macroStep —— 那是 UI 启发式步进，会让"计划推进"信号频繁误报。
   */
  private planRevision = 0;
  /** 第 68 波：本轮因输出上限被截断后已自动续写几次 */
  private truncatedContinuations = 0;
  /** 本轮迭代是否产出了交付物（写入/编辑/会改盘的命令） */
  private iterationProducedArtifact = false;
  /**
   * 【第 93 波治本】本迭代是否**获得了新信息**（读到/查到的东西不是已经见过的）。
   *
   * 来源：`repeatGuard.noteResult()` 的 `gained` —— 它已经是现成的"新信息"证据，
   * 只是原来没有接进停滞判定。接进去之后，**大仓库里逐文件读的称职探索不再被当成停滞**
   * （一手证据见 `stall-guard.ts` 头部：会话 `1790981803954-u5dmdoahw` 在第 24 轮被杀）。
   *
   * 只统计**真正执行了**的调用：读缓存命中、被守卫抑制的调用不会调用 `noteResult`，
   * 因此不会把"反复看同一份旧内容"洗成新信息。
   */
  private iterationGainedInformation = false;
  /** 第 83 波：交付物证据分级（写入类工具 / 可证明改盘命令 / 可能写命令的重复计数） */
  private artifactTracker = new ArtifactTracker();

  /**
   * 【本轮新增】"改了但没验证"守卫的三个信号。
   *
   * 真机反馈与本次实测都出现过同一个病：**模型改完文件、一次测试都没跑，就宣布「任务完成」**。
   * 本次实测（在咱们自己仓库上、真实任务）：38 次工具调用、界面显示「任务完成」，
   * 而判据 **3/7 红** —— 缺陷还在，用户却被告知做完了。
   *
   * 判据：**"写下来了"不等于"做对了"**。所以这一轮只要动过文件，就必须跑过验证
   * （测试 / 构建 / 类型检查）才允许安静地收尾；否则先提示一次，仍然不验证就**明说"未经验证"**。
   */
  private turnModifiedFiles = false;
  private turnRanVerification = false;
  /**
   * **第 140 波：最后一次编辑之后还没验证过** ✓。
   *
   * ## 为什么要单独记这个（真机证据）
   *
   * repo-02 的四轮实测（同一版本、同一提示词 ✓）：
   *
   * | 轮次 | 结果 | 提到的判据 | **在 bash 里真跑过的** |
   * |---|---|---|---|
   * | run-2 | **通过** ✓ | dsh-d8/9/10 | dsh-d8, dsh-d9, dsh-d10 ✓ |
   * | run-3 | 失败 ✗ | d9=0 | 只有 dsh-d10 ✗ |
   * | run-4 | 失败 ✗ | d9=2 | 只有 dsh-d10 ✗ |
   * | run-5 | 失败 ✗ | d8=9, d9=7 | dsh-d8, dsh-d9, dsh-d10 ✓ …**然后以 `write` 收尾** ✗ |
   *
   * run-5 是关键 ✗：它**读也读了、跑也跑了** ✓，但**跑完之后又改了文件** ✗，
   * 于是就"验证过了"这个判据而言它是**假的** ✓ ——
   * 而收尾守卫只看 `turnRanVerification`（本轮**是否跑过**验证 ✗），
   * 不看"**最后一次改动之后**是否跑过" ✗ ⇒ 守卫放行 ✓，缺陷留在盘上 ✗。
   *
   * 所以：编辑把它置 **true** ✓，验证命令把它置回 **false** ✓，守卫看它 ✓。
   */
  private turnEditsAfterVerification = false;
  private verificationNudgeIssued = false;
  /**
   * **本会话编辑过的源码文件**（第 154 波 ✓）—— 收尾时用它算"同族判据有没有跑过" ✓。
   *
   * 与 `symbolSiblingsSentFor` 的区别 ✗：那个是**每回合**清空的额度 ✓；
   * 这个是**整个会话**的账 ✓（收尾要知道"这一路改过哪些源码"✓）。
   */
  private sessionEditedSources = new Set<string>();
  /** "有没跑过的同族判据"这条提醒**每会话只发一次** ✓（别把收尾变成复读机 ✗）。 */
  private unrunSiblingsNudged = false;
  /** 守卫判定「该停了」时的提示语 —— 在迭代末尾像 writeRejected 一样终止循环 */
  private guardStopMessage: string | null = null;
  /** 停档的类别（零信息增益 / 只读枚举），决定给用户看的那句话 */
  private guardStopKind: GuardKind = "no-gain";
  /**
   * 本轮迭代里被守卫拦下的调用数。
   *
   * 为什么需要它：被拦下的调用**仍然会走一遍 tool_start 事件**，因此会被算作
   * 「这一轮有工具调用」→ 无进展计数器被清零 → 既有的 runaway 阀门永远不触发。
   * 把这一部分减掉，"抑制"才是真的"这一步没有进展"。
   */
  private guardSuppressedThisIteration = 0;
  // Guidance queue — allows mid-turn message injection.
  // Messages are consumed at iteration boundaries (before each LLM call),
  // never during tool execution or subagent waiting.
  private guidanceQueue: any = null;
  // Flag: when true, an AbortError was caused by immediate guidance injection,
  // not a user cancel. The loop should continue to the next iteration instead
  // of stopping.
  private guidanceInterrupt: boolean = false;
  private needsYouQueue: any = null;
  private fileChangeTracker: FileChangeTracker | null = null;
  private agentId: string = "main";
  private currentSessionId: string | null = null;

  // ===== P0-7.1: DI accessors — 完全通过 ctx.get() 消费服务 =====
  // 当 Fiber Context 可用时使用 ctx.get()，无 ctx 时回退到单例（仅测试环境）
  private _ctx: any = null;

  /** 设置 Cordis Context，设置后所有服务通过 ctx.get() 消费 */
  setContext(ctx: any) {
    this._ctx = ctx;
    // P2-6.5建议5: 链路自愈机制 — 监听 service/unload 事件
    // Provider 卸载 → 事件触发 → 检查是否影响当前会话 → 影响则记录警告
    if (ctx && ctx.on) {
      try {
        ctx.on('service/unload', (data: any) => {
          const serviceName = data?.name || 'unknown';
          const critical = ['llm', 'tools', 'messageStorage'];
          if (critical.includes(serviceName)) {
            console.warn(`[AgenticLoop] Critical service "${serviceName}" unloaded during session, will check on next iteration`);
          }
        });
      } catch (e) { console.warn('[agentic-loop.ts]', e) }
    }
  }

  /** P0-7.1 / 6.5建议2: Provider 健康检查 — 每轮迭代开始时检查关键服务 */
  private checkCriticalServices(): boolean {
    if (!this._ctx) return true;
    const critical = ['llm', 'tools', 'messageStorage'];
    for (const name of critical) {
      if (!this._ctx.get(name)) {
        console.error(`[AgenticLoop] Critical service "${name}" not available`);
        return false;
      }
    }
    return true;
  }

  /** P1-6.5建议3: 优雅降级提示 — 返回降级警告消息 */
  private getDegradationWarning(): string | null {
    if (!this._ctx) return null;
    const warnings: string[] = [];
    if (!this._ctx.get('permission')) {
      warnings.push('⚠️ 权限服务不可用，所有工具调用将需要确认');
    }
    if (!this._ctx.get('costTracker')) {
      warnings.push('⚠️ 费用追踪不可用，可能产生额外费用');
    }
    if (!this._ctx.get('compaction') && !this._ctx.get('compactionBasic')) {
      warnings.push('⚠️ 上下文压缩不可用，上下文溢出时将直接停止');
    }
    if (!this._ctx.get('retry') && !this._ctx.get('llmRetry')) {
      warnings.push('⚠️ 重试策略不可用，LLM 调用失败将直接报错');
    }
    return warnings.length > 0 ? warnings.join('\n') : null;
  }

  private getPermissionManager() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('permission'); if (s) return s; warnOnce('svc:permission', '[AgenticLoop] Service "permission" not available, falling back to singleton'); }
    return getPermissionManager();
  }
  private evaluateSecurityMode(
    mode: string,
    tool: string,
    resource: string | undefined,
    normalEvaluation: "allow" | "deny" | "ask",
  ): "allow" | "deny" | "ask" {
    return evaluateWithSecurityMode(mode as any, tool, resource, normalEvaluation);
  }
  private getTelemetry() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('telemetry'); if (s) return s; warnOnce('svc:telemetry', '[AgenticLoop] Service "telemetry" not available, falling back to singleton'); }
    return getTelemetry();
  }
  private getTranscriptCache() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('transcriptCache'); if (s) return s; warnOnce('svc:transcriptCache', '[AgenticLoop] Service "transcriptCache" not available, falling back to singleton'); }
    return TranscriptCache;
  }
  private getMessageStorage() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('messageStorage'); if (s) return s; warnOnce('svc:messageStorage', '[AgenticLoop] Service "messageStorage" not available, falling back to singleton'); }
    return MessageStorage;
  }
  private getVisionProxy() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('visionProxy'); if (s) return s; warnOnce('svc:visionProxy', '[AgenticLoop] Service "visionProxy" not available, falling back to singleton'); }
    return getVisionProxy();
  }
  /**
   * 快照服务是**按 cwd 单例**的（`getSnapshotService(cwd)`：SnapshotPanel、测试都这么取），
   * 没有任何 Provider 注册过 `ctx.provide('snapshot', …)` —— 于是原来那句
   * `ctx.get('snapshot')` 必然落空、并在**每次工具调用**上打一遍带调用栈的 warn
   * （用户报的控制台噪声：一次 write 就打两遍）。这里直接用按 cwd 取单例的公开入口。
   */
  private getSnapshotService(cwd?: string) {
    return getSnapshotService(cwd || this.lastCwd || ".");
  }
  private getEventLog() {
  // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
  if (this._ctx) { const s = this._ctx.get('eventLog'); if (s) return s; warnOnce('svc:eventLog', '[AgenticLoop] Service "eventLog" not available, falling back to singleton'); }
  return getEventLog();
}

/** P1: 轨迹记录服务 — 对标 DSH ui-trajectory，记录 Agent 执行每一步的完整轨迹 */
private getTrajectoryService(): { record: (sessionId: string, type: string, data: any, duration?: number) => string } | null {
  if (this._ctx) {
    const s = this._ctx.get('uiTrajectory');
    if (s) return s;
  }
  // 回退到 tryGetCtx（Consumer 模式）
  try {
    const ctx = tryGetCtx();
    if (ctx) {
      const s = (ctx as any).get('uiTrajectory');
      if (s) return s;
    }
  } catch { /* Context 未初始化 */ }
  return null;
}

/** P1: 轨迹记录辅助方法 — 安全调用，失败不阻断主循环 */
private recordTrajectory(sessionId: string, type: string, data: any, duration?: number): void {
  try {
    const svc = this.getTrajectoryService();
    if (svc) svc.record(sessionId, type, data, duration);
  } catch (e) { console.warn('[AgenticLoop] trajectory record failed:', e) }
}

/** P1: 获取 FileChangeTracker — 优先从 ctx.get('fileChangeTracker') 消费 Provider 服务 */
private getFileChangeTrackerService(): FileChangeTracker | null {
  if (this._ctx) {
    const s = this._ctx.get('fileChangeTracker');
    if (s) return s;
  }
  return null;
}

  /** Match tool name against allowlist pattern (supports wildcards) */
  private matchToolPattern(name: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    return regex.test(name);
  }

  /** Check if a tool is allowed by the agent's toolAllowlist */
  private isToolAllowed(toolName: string): boolean {
    if (!this.config.toolAllowlist || this.config.toolAllowlist.length === 0) return true;
    return this.config.toolAllowlist.some((pattern) => this.matchToolPattern(toolName, pattern));
  }

  // E3: Incremental message cache — avoids redundant full conversions
  private msgCache: {
    sessionId: string;
    rawCount: number;
    rawLastId: string;
    rawLastFingerprint: string;
    llmMessages: any[];
  } | null = null;

  // F3.6: Retrospective tracking — counts repeated errors to suggest AGENTS.md updates
  private retrospectiveErrorCount = 0;
  private retrospectiveSuggested = false;
  /** P-OPT3: Last SSE activity timestamp — for heartbeat-aware idle tracking */
  private lastStreamActivity: number = 0;
  /** P-OPT4: Last request header fingerprint — dedup to avoid unnecessary cache invalidation */
  private lastRequestHeader: string | null = null;

  constructor(
    provider: LLMProvider,
    tools: ToolRegistry,
    config?: Partial<LoopConfig>,
  ) {
    this.provider = provider;
    this.tools = tools;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    // R5: 尝试从 Cordis Context 获取服务，回退到单例
    const ctx = tryGetCtx();
    if (ctx) this._ctx = ctx;
    this.guidanceQueue = getGuidanceQueue();
    this.needsYouQueue = getNeedsYouQueue();
    this.executor = new StreamingToolExecutorImpl({
      // 契约查询器：调度（并发）与超时都靠它读**工具自己的声明**，
      // 而不是执行器里再维护一份名单。`this.tools` 在 handle() 时已注册完毕，
      // 这里传的是闭包，调用时才求值，所以构造顺序不影响正确性。
      contractOf: (toolName: string) => this.tools.getContract(toolName),
      ...(config?.toolExecutor ?? {}),
    });
    // Sync the model's real context window into TokenTracker so pressure
    // estimation uses the correct denominator (DSH: model-aware window).
    if (this.config.contextWindow) {
      getTokenTracker().setContextWindow(this.config.contextWindow);
    }
    this.retryExecutor = new RetryExecutor({
      maxAttempts: 5,
      baseDelay: 1000,
      backoffMultiplier: 2,
      maxDelay: 30000,
      totalTimeout: 5 * 60 * 1000,
    });
    this.state = this.createInitialState();
  }

  private createInitialState(): LoopState {
    return {
      iteration: 0,
      maxIterations: this.config.maxIterations,
      totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, uncachedInputTokens: 0 },
      toolCallsInIteration: 0,
      consecutiveErrors: 0,
      contextPressure: 0,
      isCompacting: false,
      compactedThisIteration: false,
      consecutiveCompactions: 0,
      microCompactedThisRun: false,
      costDegraded: false,
      writeRejected: false,
      consecutiveNoProgress: 0,
      lastFinishReason: "stop",
      lastIterationTextChars: 0,
      lastIterationError: null,
    };
  }

  /**
   * Lightweight heuristic step estimation — no LLM call needed.
   * Analyzes the user message to estimate how many agentic iterations
   * the task will likely require.
   */
  private estimateSteps(userMessage: string): { plan: StepPlan[] | null; total: number | null } {
    const msg = userMessage.toLowerCase();
    const zh = /[\u4e00-\u9fa5]/.test(userMessage);

    // Count action keywords that suggest tool usage
    const toolKeywords = [
      "read", "write", "edit", "create", "delete", "search", "grep",
      "run", "execute", "test", "build", "install", "fetch", "spawn",
      "读取", "写入", "编辑", "创建", "删除", "搜索", "运行", "执行",
      "测试", "构建", "安装", "获取", "子智能体", "重构", "修改",
    ];
    const fileKeywords = ["file", "文件", ".ts", ".js", ".py", ".rs", ".json", ".css", ".html"];
    const multiKeywords = ["multiple", "all", "every", "每个", "所有", "多个", "批量"];

    let toolCount = 0;
    for (const kw of toolKeywords) {
      if (msg.includes(kw)) toolCount++;
    }
    let fileCount = 0;
    for (const kw of fileKeywords) {
      if (msg.includes(kw)) fileCount++;
    }
    const isMulti = multiKeywords.some(kw => msg.includes(kw));

    // Estimate total steps
    let total: number;
    const steps: StepPlan[] = [];

    if (toolCount === 0 && looksLikeExecutableTask(userMessage)) {
      // 中文任务意图句（无英文工具词）：如"修复卡死的问题"——此前被误判为
      // 纯文本问答 → 只显示"回答问题"。任务型消息给 3 步语义化兜底（主路径
      // 仍是 LLM 计划），首步含任务摘要，避免"第1步 回答问题"的无效展示。
      const brief = taskBrief(userMessage, 24);
      total = 3;
      steps.push({ title: zh ? `分析：${brief}` : `Analyze: ${brief}` });
      steps.push({ title: zh ? "定位问题根因" : "Locate the root cause" });
      steps.push({ title: zh ? "实施修复并验证" : "Fix and verify" });
    } else if (toolCount === 0) {
      // Pure text answer
      total = 1;
      steps.push({ title: zh ? "回答问题" : "Answer question" });
    } else if (toolCount <= 2 && !isMulti) {
      // Simple tool task (read + answer, write + answer)
      total = 2;
      steps.push({ title: zh ? "分析任务" : "Analyze task" });
      steps.push({ title: zh ? "执行并回答" : "Execute and answer" });
    } else if (toolCount <= 4 && fileCount <= 2) {
      // Moderate task (read + edit + verify)
      total = 3;
      steps.push({ title: zh ? "读取和分析" : "Read and analyze" });
      steps.push({ title: zh ? "执行修改" : "Make changes" });
      steps.push({ title: zh ? "验证结果" : "Verify results" });
    } else if (isMulti || fileCount > 3) {
      // Complex multi-file task
      total = 5;
      steps.push({ title: zh ? "分析项目结构" : "Analyze project" });
      steps.push({ title: zh ? "读取相关文件" : "Read files" });
      steps.push({ title: zh ? "执行修改" : "Make changes" });
      steps.push({ title: zh ? "验证和测试" : "Verify and test" });
      steps.push({ title: zh ? "总结结果" : "Summarize" });
    } else {
      // Default moderate task
      total = 3;
      steps.push({ title: zh ? "分析任务" : "Analyze task" });
      steps.push({ title: zh ? "执行操作" : "Execute" });
      steps.push({ title: zh ? "验证结果" : "Verify" });
    }

    return { plan: steps, total };
  }

  /**
   * Plan all steps for a task before the main loop.
   * Makes a lightweight non-streaming LLM call to get a structured plan.
   * Returns an array of step titles for pre-planning.
   */
  private async planSteps(userMessage: string): Promise<StepPlan[] | null> {
    try {
      const lang = (await import("../i18n/lang")).getLang();
      const estPrompt = lang === "zh"
        ? `你是一个任务规划器。根据用户的具体任务，拆解为有意义的宏观执行步骤（这些步骤会实时展示给用户，作为"第X/X步"进度）。

规则：
- 步骤必须从用户的真实任务出发，是解决这个问题的具体工作单元。诊断/修复类任务的自然结构是：分析<问题>的原因 → 定位/诊断 → 实施修复 → 验证问题不再出现（可参照此结构，但标题要结合任务内容）
- 步骤标题要能回答"正在解决什么问题"，可包含问题对象（如"分析 App 卡死的原因""修复调用链路的死锁""验证卡死是否复现"）
- 严禁使用与任务无关的万能模板标题：如"回答问题""执行命令""分析任务""执行修改""验证结果""运行命令"等 —— 这些没有告诉用户任何任务信息
- 不要列出中间侦查小步骤（读取文件、搜索代码、查看目录、运行 grep 等不算步骤）
- 执行中计划允许动态调整：发现必须先处理的新问题时，会插入新步骤并顺延编号（这不是你现在要做的事）
- 每个明确的子任务 = 1 步；最后一步通常是验证/测试/总结（如果任务需要改动代码）
- 总步数 1-10 步，通常 3-6 步

用 JSON 数组格式回复，每个元素包含 title 字段（简短的中文步骤描述）。不要有其他解释。
好例：[{"title":"分析页面卡死的原因"},{"title":"诊断主线程阻塞链路"},{"title":"修复卡死问题"},{"title":"测试验证卡死不再出现"}]
坏例：[{"title":"回答问题"},{"title":"执行命令"}]`
        : `You are a task planner. Break down the user's concrete task into meaningful macro execution steps (these are shown live to the user as "Step X/Y" progress).

Rules:
- Steps must derive from the user's actual task — concrete units of work that solve it. Diagnosis/fix tasks naturally follow: analyze WHY <problem> happens → locate/diagnose the chain → implement the fix → verify the problem no longer reproduces (follow this shape, but tie titles to the task content)
- Step titles must answer "what problem am I solving right now"; include the problem subject (e.g. "Analyze why the app freezes", "Fix the deadlock in the call chain", "Verify the freeze no longer reproduces")
- NEVER use generic template titles unrelated to the task, such as "Answer question", "Execute command", "Analyze task", "Make changes", "Verify results" — they tell the user nothing about the task
- Do NOT list intermediate investigation steps (reading files, searching code, listing dirs, running grep are not steps)
- The plan is dynamically adjustable during execution (new steps may be inserted ahead of the current one when a prerequisite problem is discovered) — you do not need to handle that now
- Each concrete subtask = 1 step (e.g. "implement login", "fix DB concurrency", "add export feature" are each one step); the final step is usually verify/test/build/summarize
- Total 1-10 steps, usually 3-6

Reply as a JSON array, each element has a "title" field (short step description). No other explanation.
Good example: [{"title":"Analyze why the page freezes"},{"title":"Diagnose the main-thread blocking chain"},{"title":"Fix the freeze"},{"title":"Test that the freeze no longer reproduces"}]
Bad example: [{"title":"Answer question"},{"title":"Execute command"}]`;

      const request: LLMRequest = {
        model: this.config.model || this.provider.id,
        messages: [
          { id: "system", role: "system", content: estPrompt },
          { id: "user", role: "user", content: userMessage.substring(0, 500) },
        ],
        temperature: 0,
        stream: false,
        abortSignal: this.abortController!.signal,
      };

      const response = await this.provider.complete(request);
      // 健壮的 JSON 解析 — 使用 extractJSON 处理 markdown 包裹、中文标点、尾部逗号等
      const steps = extractJSON<StepPlan[]>(response.content);
      if (Array.isArray(steps) && steps.length > 0) {
        // 清洗：标题必须非空（模型可能输出空/纯空白 title → UI 会出现
        // "第X步 · "空白胶囊）；清洗后为空视为规划失败 → 回退启发式。
        const cleaned = steps
          .map((s) => ({ title: String(s?.title ?? "").trim() }))
          .filter((s) => s.title.length > 0)
          .slice(0, 20);
        if (cleaned.length > 0) {
          debugLog("agent-loop", `Planned ${cleaned.length} steps:`, cleaned.map(s => s.title));
          return cleaned;
        }
      }
    } catch (err) {
      console.warn("[AgenticLoop] Step planning failed:", err);
    }
    return null;
  }

  async *run(
    sessionId: string,
    userMessage: string,
    cwd: string,
    systemPrompt: string,
  ): AsyncGenerator<LoopEvent, LoopResult, unknown> {
    this.abortController = new AbortController();
    /*
     * 新的回合 = 新的派发闸门：执行器的中止标志只在这里复位。
     *
     * 为什么不在 `executor.execute()` 入口复位：用户点 ■ 最常见于**模型正在流式输出**
     * 的时候，那一轮的工具执行还没开始 —— 入口复位会把刚刚发生的中止抹掉，
     * 排队中的工具照旧开跑（本条要修的形态）。
     */
    this.executor.clearAbort();
    this.state = this.createInitialState();
    this.currentSessionId = sessionId;

    // 第 62 波（审计修正）：守卫必须**按轮次**重置，不能只按实例。
    // AgenticLoop 是按会话缓存复用的，构造期重置等于"跨轮次累计"——
    // 于是用户在几轮之后第一次叫它读同一个文件，就会莫名收到「重复调用被跳过」。
    // 新的用户指令 = 新的意图，阈值只应在一轮之内达到。
    this.repeatGuard.reset();
    this.guardStopMessage = null;
    this.guardStopKind = "no-gain";
    this.guardSuppressedThisIteration = 0;
    this.delegationProgressAtWait.clear();
    this.delegationStuckPeeks.clear();
    this.stallGuard.reset();
    this.artifactTracker.reset();
    // 【第 108 波】"红测试收尾"守卫：每轮重置（同一轮里最多提醒一次，见 noteTestRun / 收尾判定）
    this.lastTestRun = null;
    this.redTestNudges = 0;
    // 【第 109 波】按文件记的测试状态也要按轮清空（否则上一轮的红会污染这一轮）
    this.testFileStatus.clear();
    // 【本轮新增】"改了但没验证"守卫：每轮重置
    this.turnModifiedFiles = false;
    this.turnRanVerification = false;
    this.turnEditsAfterVerification = false; // 第 140 波：时序判据 ✓
    this.verificationNudgeIssued = false;
    this.planRevision = 0;
    this.truncatedContinuations = 0;
    this.iterationProducedArtifact = false;
    this.iterationGainedInformation = false;
    /**
     * **本回合的注入状态**（第 109/121 波）—— 与上面这些"按轮重置"的字段放在一起 ✓。
     *
     * ⚠️ 它们原来放在 `run()` 的最顶部 ✗，结果把 `this.truncatedContinuations = 0`
     * 这类**按源码文本前若干字符断言**的判据（TRUNC-4 / GUARD-15 / DELE-043）挤出了窗口 ✗
     * ⇒ 三条判据变红 ✗。挪到这里既修好了那个问题 ✓，语义上也更对（就是回合初始化 ✓）。
     */
    this.lastUserMessage = userMessage;
    this.lastCwd = cwd;
    this.familyReminderSentInTurn = false;
    this.symbolSiblingsSentFor.clear();
    /**
     * **第 116–118 波排查痕迹**（`codem-debug=agent-loop` 时可见 ✓）：它曾经是排查主力 ✓ ——
     * 在"机制在装机版里到不了模型"的追查中，正是靠"这一行有没有出现"才证明 `run()` 真的在跑 ✓
     * （当时我先起应用再挂 CDP 监听 ✗，而驱动会先把应用杀掉重起 ✗ ⇒ 录到的是**死掉的旧实例** ✗，
     *  于是我一度错误地判定"这条路径不跑" ✗）。
     */
    debugLog("agent-loop", "[run] entered | session=", sessionId, "| cwd=", cwd || "(空)", "| msgLen=", userMessage?.length ?? 0);

    // Model-aware context window: resolve the current model's real window
    // from the provider and sync it into TokenTracker. Without this the
    // tracker keeps its 128k default, so 1M-window models (MiMo/DeepSeek/
    // Gemini) hit the 0.8 compaction threshold after only a few turns.
    await this.resolveModelContextWindow();

    // R3-3.4: Crash repair — fix incomplete tool calls from previous session
    try {
      const { repairCrashedSession } = await import("./compaction-control");
      const repairResult = repairCrashedSession(sessionId);
      if (repairResult.repairedCount > 0) {
        console.log(`[AgenticLoop.run] Crash repair: fixed ${repairResult.repairedCount} incomplete tool calls`);
      }
    } catch (crashErr) {
      console.warn("[AgenticLoop.run] Crash repair failed (non-critical):", crashErr);
    }

    // R3-3.6: Runtime invariants — check "visible = recorded" in debug mode
    if (process.env.NODE_ENV === "development" || process.env.DEBUG_INVARIANTS === "1") {
      try {
        const { checkVisibleRecordedInvariant } = await import("./runtime-invariants");
        const result = checkVisibleRecordedInvariant(sessionId);
        if (!result.passed) {
          console.warn(`[AgenticLoop.run] Invariant violations detected:`, result.violations);
        }
      } catch (invErr) {
        // Non-critical — invariants are debugging tool
      }
    }

    // D2: Initialize process-level sandbox ACL guard
    try {
      const { initDefaultSandbox, getSandboxGuard } = await import("../sandbox/sandbox-acl");
      if (!getSandboxGuard()) {
        initDefaultSandbox(cwd);
        console.log(`[AgenticLoop.run] Sandbox ACL initialized for workspace: ${cwd}`);
      }
    } catch (sandboxErr) {
      // Non-critical — sandbox is defense-in-depth
      console.warn("[AgenticLoop.run] Sandbox init failed:", sandboxErr);
    }

    /**
     * 上一轮遗留的引导消息（mid-turn steering）：**不许静默丢弃**。
     *
     * ## 缺陷形态（修复前）
     *
     * 这里原来是 `this.guidanceQueue.expire(sessionId)` —— 一句**静默删除**，
     * 而且它是 `run()` 的**第一件事**。窗口是真实的：
     * `sendGuidance()`（本文件 `:4094`）只检查 `currentSessionId`，而该字段
     * 在 `run()` 开头被赋值后**从不复位**（`grep currentSessionId` 只有
     * `:880` 一处赋值）。于是「循环已经决定停下、下一次 `run()` 还没开始」的间隙里，
     * 用户手打的纠偏会**入队成功**（`enqueue` 返回条目、UI 气泡出现、`guidance-received`
     * 一类反馈照走），紧接着下一次 `run()` 把它删掉：模型没见过、用户也没有任何信号。
     * `guidance-queue.ts` 的 `expire` 文档当时还写着「Called when the agentic loop
     * finishes」—— 与唯一的调用点（回合**开始**）不符。
     *
     * ## 本轮的处置（三选一里选了哪条、为什么）
     *
     * 备选：① 把 `expire()` 挪到「回合终态」；② 把残留变成**真实且落库的 user 消息**；
     * ③ 至少发一条可见通知。选 ②，理由：
     * - ① 在本文件里**没有单点终态**：`run()` 有 10+ 个 `return`（abort / 截断 /
     *   重复守卫 / 成本上限 / …），把清理塞进每一条分支就等于「漏一条就泄漏一次」，
     *   而 `run()` 是生成器、没有包住整个循环的 `try/finally` 可挂 ——
     *   要造出单点终态得先把 900 行循环拆成内部生成器，改动面远大于收益；
     * - ② 同时满足「不可能丢」与「可见」：消息**真的会到模型手里**
     *   （落库后本轮 `buildMessages`（`:1293`）立刻读到），而且**留在会话历史里**
     *   用户能看见 —— 与 DSH 的 inbox「持久投影」同取向
     *   （`.deepseek-harness-ref/packages/core/agent-loop/src/inbox.ts` 的丢弃会发
     *   `agent/inbox/discarded` 事件，这里走得更远：不丢，落库）；
     * - ③ 只是告知，用户的话仍然没了 —— 不作为唯一手段，但这里**仍然复用**
     *   `guidance_received` 让 UI 把那条状态栏气泡收掉（否则气泡会永久残留），
     *   于是「可见」也一并具备。
     *
     * ## 为什么落库用 GUIDANCE_MESSAGE_TEMPLATE
     *
     * 与「本轮被正常消费」的引导消息**同一个形态**：模型据此知道这是运行期纠偏指令，
     * 而不是一条要正式回应的普通聊天消息。区别只有时机 —— 它晚了一轮。
     */
    const leftoverGuidance = this.guidanceQueue.drain(sessionId);
    for (const item of leftoverGuidance) {
      try {
        this.getMessageStorage().createMessage({
          id: `guidance-carryover-${item.id}`,
          role: "user",
          content: GUIDANCE_MESSAGE_TEMPLATE(item.message),
          timestamp: item.timestamp,
          status: "done",
        }, sessionId);
        // 落库改变了历史 ⇒ 让消息缓存重建（否则本轮可能用旧投影，看不到这条）
        this.msgCache = null;
        console.log(
          `[AgenticLoop] Carried over unconsumed guidance ${item.id} into the session as a persisted user message`,
        );
      } catch (e) {
        // 落库失败也**不许把它吞掉**：内容直接说给用户听（模型这一轮看不到，
        // 但用户至少知道要重发），与「静默删除」是两种完全不同的结果。
        console.warn(`[AgenticLoop] Failed to persist carried-over guidance ${item.id}:`, e);
        yield {
          type: "text_delta",
          text: `\n\n⚠️ 你上一轮结束后发送的引导消息没能写入会话历史（「${item.message}」），本轮模型看不到它，请重新发送。\n`,
        };
      }
      // 复用既有事件：UI 据此移除那条状态栏气泡 + 提示「已注入」——
      // 它现在确实是**已注入**（作为落库的 user 消息进入本轮请求）。
      yield { type: "guidance_received", message: item.message, guidanceId: item.id };
    }
    // 每次新对话重置快照状态，确保每次对话独立创建快照
    this.resetSnapshot();
    // Reset tool deduplication state — new user message = new task, previous
    // read/write caches are no longer relevant
    this.readCache.clear();
    this.writeCache.clear();
    this.waitedSubagents.clear();
    this.spawnedSubagents.clear(); // no-op: 旧模式遗留
    this.state.microCompactedThisRun = false;
    console.log(`[AgenticLoop.run] sessionId: ${sessionId}, userMessage: ${userMessage.substring(0, 80)}...`);

    // P0-2: Initialize tool pipeline with 5-layer middlewares
    /**
     * 第 87 波（接线修复）：这个开关此前**恒为 `false`** —— 而设置面板里早就有
     * 一个"🔒 沙箱模式（限制写入范围到工作目录）"的勾选框（写 `codem-sandbox-enabled`）：
     * 用户打开它、界面显示已开启，`SandboxGuard` 却从来没被启用过（模型照样写工作区外的文件）。
     * 现在按该设置项真实生效（默认仍是关闭，与面板默认一致）。
     */
    const sandboxEnabledNow = isSandboxAclEnabled();
    if (!(globalThis as any).__codemSandboxNoticeLogged) {
      (globalThis as any).__codemSandboxNoticeLogged = true;
      console.info(
        sandboxEnabledNow
          ? '[Sandbox] 沙箱模式已启用（codem-sandbox-enabled=true）：工作区外的写入/读取会被 SandboxGuard 拦下。'
          : '[Sandbox] 沙箱模式未启用（设置 → 安全 → 🔒 沙箱模式 可开启）：工作区外写入不会被拦截；' +
            '仍然生效的是工具级受保护路径（.git/.env/node_modules）与权限层。',
      );
    }
    await initDefaultPipeline({
      isPlanMode: () => this.config.collaborationMode === "plan",
      // 第 87 波：跟随设置（原来是硬编码 () => false，面板里的沙箱开关形同虚设）
      isSandboxEnabled: () => isSandboxAclEnabled(),
      // 第 120 轮：沙箱与计划模式守卫改读**工具契约**，不再维护工具名名单。
      // 判据变成「sideEffectScope !== "none"」与「readOnly」—— 新增工具天然被覆盖，
      // 不需要谁记得来登记（旧名单里还混着 read_file / cat / find 等幽灵名）。
      contractOf: (toolName: string) => this.tools.getContract(toolName),
      // 原始契约（归一化 / 结果渲染这类**行为钩子**从它取：解析后的契约只带值）
      rawContractOf: (toolName: string) => this.tools.getRawContract(toolName),
      // 入参校验读 ToolDef.parameters（下发给模型的同一份 schema）
      toolDefOf: (toolName: string) => this.tools.get(toolName),
      isPathWithinWorkspace: (path: string, cwd: string) => {
        // Basic check: path should be within cwd
        const normalized = path.replace(/\\/g, "/");
        const cwdNorm = cwd.replace(/\\/g, "/");
        return normalized.startsWith(cwdNorm) || normalized === cwdNorm;
      },
      checkPermission: async (toolName: string, args: Record<string, unknown>, ctx: any) => {
        // S0-1: Full permission check — migrated from toolHandler inline logic
        // This replaces the simplified version and includes:
        // - Resource extraction (path/command)
        // - Bash deep security analysis
        // - Security mode evaluation
        // - User permission request dialog (onPermissionRequest)
        const secMode = this.config.securityMode || "ask";
        if (secMode === "full" || !this.config.enablePermissions) {
          return { allowed: true };
        }

        const resource = typeof args.path === "string" ? args.path
          : typeof args.command === "string" ? args.command
          : undefined;
        const permissionManager = this.getPermissionManager();
        let rawAction = permissionManager.getEvaluator().evaluate(toolName, resource);

        // Bash deep security analysis — detect dangerous patterns
        if (toolName === "bash" && typeof args.command === "string") {
          try {
            const { evaluateWithBashAnalysis } = await import("../permission/bash-analyzer");
            const bashResult = evaluateWithBashAnalysis(args.command, rawAction);
            if (bashResult.action === "ask" && rawAction === "allow") {
              console.log(`[Pipeline] Bash analyzer upgraded action to "ask": ${bashResult.reason}`);
              rawAction = "ask";
            }
          } catch (bashErr: any) {
            console.warn(`[Pipeline] Bash analyzer error (non-blocking): ${bashErr.message}`);
          }
        }

        const action = this.evaluateSecurityMode(secMode, toolName, resource, rawAction);

        if (action === "ask" && this.config.onPermissionRequest) {
          const requestId = `perm-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
          const request: PermissionRequest = {
            id: requestId,
            sessionId: ctx.sessionId,
            tool: toolName,
            input: args,
            resource,
            timestamp: Date.now(),
          };

          const result = await this.config.onPermissionRequest(request);

          if (result.action === "deny") {
            return { allowed: false, denyMessage: `Permission denied by user for tool "${toolName}"` };
          }
        } else if (action === "deny") {
          return { allowed: false, denyMessage: `Permission denied by policy for tool "${toolName}"` };
        } else if (action === "ask") {
          /**
           * 第 83 波（审计修正）：**没有人可以问的时候必须拒绝，不能默认放行**。
           *
           * 原来 `action === "ask"` 而 `onPermissionRequest` 为空时，两个分支都不命中，
           * 直接落到 `return { allowed: true }` —— "ask"模式在任何**没接回调的调用方**
           * （第三方/嵌入式 `engine.process(...)`、子智能体、后台桥接）那里等于 **full**：
           * 本该要用户确认的写操作被静默放行。这是"守卫被缺省分支绕过"的典型。
           *
           * 现在 fail-closed：明确拒绝并说清原因（用户可改为 auto/full，或让调用方提供回调）。
           */
          return {
            allowed: false,
            denyMessage:
              `Permission required for tool "${toolName}" but no approval channel is available ` +
              `(the caller did not provide onPermissionRequest). Denied by default — ` +
              `set the security mode to "auto"/"full" or provide an approval callback.`,
          };
        }

        return { allowed: true };
      },
      // R3-1.1: Spill policy — 32KB 上限，超过的纯文本工具输出被溢出存储
      maxInlineBytes: 32768,
    });

    // P2-14: Record telemetry — turn start
    const telemetry = this.getTelemetry();
    const turnStartTime = Date.now();
    this.state.turnStartTime = turnStartTime;
    telemetry.record(sessionId, "turn_start", {
      userMessageLength: userMessage.length,
      collaborationMode: this.config.collaborationMode || "default",
    });
    // P1: Record trajectory — turn start (对标 DSH ui-trajectory)
    this.recordTrajectory(sessionId, "user_input", { content: userMessage.substring(0, 500) });

    // User message is saved by App.tsx (main session) or already in DB (sub-agent)
    // Don't save here to avoid duplicates

    // Local assistant message ID for tracking
    let assistantMsgId = `msg-${Date.now() + 1}`;

    // Pre-plan: 任务语义计划（对标 dsh 客户端 todo 语义步骤列表）。
    // 1) 纯文本问答（闲聊/非执行型任务）→ 保持启发式 1 步，不额外调 LLM；
    // 2) 执行型任务（修复/排查/实现/重构…，或启发式估步 ≥2）→ 总是让 LLM
    //    生成面向具体任务的语义步骤（分析原因 → 定位/诊断 → 修复 → 验证），
    //    30s 超时，失败回退启发式估算 —— 避免出现"1、回答问题；2、执行命令"
    //    这种与用户任务无关的通用步骤。
    const est = this.estimateSteps(userMessage);
    this.activePlan = { plan: est.plan, total: est.total, fromLlm: false };
    this.planDirty = false;
    const executable = looksLikeExecutableTask(userMessage) || (est.total ?? 0) >= 2;
    if (executable) {
      try {
        // PLAN_TIMEOUT_MS: 规划调用是轻量非流式请求，30s 内应返回。
        // provider 层已有 120s 总超时；这里更快回退到启发式估算，
        // 避免主循环在规划阶段空等（对标 DSH request deadline 语义）。
        const PLAN_TIMEOUT_MS = 30_000;
        const llmPlan = await Promise.race([
          this.planSteps(userMessage),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), PLAN_TIMEOUT_MS)),
        ]);
        if (llmPlan && llmPlan.length > 0) {
          this.activePlan = { plan: llmPlan, total: llmPlan.length, fromLlm: true };
          console.log(`[AgenticLoop] LLM plan (${llmPlan.length} steps):`, llmPlan.map(s => s.title));
        }
      } catch (planErr) {
        console.warn("[AgenticLoop] LLM plan failed, using heuristic:", planErr);
      }
    }
    debugLog("agent-loop", `Plan ${this.activePlan.total ?? 0} steps:`, this.activePlan.plan?.map(s => s.title));

      // Main loop — DSH-aligned: no built-in turn budget, no token cap.
      // The loop runs until the model produces no tool calls (natural completion).
      // DSH's agent loop has NO token budget cap and NO iteration cap on the main
      // loop — it only stops on natural completion or user abort. We align with this.
      // Safety valves (checked at the top of each iteration):
      //   1. maxIterations (if > 0): hard cap, ONLY used by sub-agents to prevent recursive runaway
      //   2. consecutiveNoProgress: stop if model is stuck in a loop with no progress
      while (true) {
        /**
         * 本轮要注入到 system 消息尾部的「活跃目标」摘要。
         *
         * 为什么在这里声明：目标摘要要在迭代体**前段**算出来（见下面 P2-12 那段），
         * 而注入点在迭代体**后段**（`apiMessages` 构建完、与 time-context 同处）。
         * 两处之间没有别的共享变量可用，所以用迭代作用域的 `let` 串起来。
         * 为空表示本轮没有活跃目标（或 goal 模块不可用）——两者都静默跳过。
         */
        let goalSummaryForPrompt = "";
        // Safety valve 1: hard iteration cap (sub-agent runaway prevention only)
        if (this.state.maxIterations > 0 && this.state.iteration >= this.state.maxIterations) {
          break;
        }
        // Safety valve 2: consecutive no-progress detection
        // This is the sole runaway protection for the main loop, matching DSH's
        // design of no token budget cap and no iteration cap on the main loop.
        if (this.state.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
          console.warn(`[AgenticLoop] Runaway detected: ${MAX_CONSECUTIVE_NO_PROGRESS} consecutive iterations with no progress`);
          yield { type: "text_delta", text: `\n\n⚠️ **检测到循环停滞**（连续 ${MAX_CONSECUTIVE_NO_PROGRESS} 次迭代无进展），任务已停止以防止死循环。请检查模型是否陷入重复操作。` };
          break;
        }
        this.state.iteration++;
        this.state.toolCallsInIteration = 0;
        this.state.compactedThisIteration = false;
        this.guardSuppressedThisIteration = 0;
        this.iterationProducedArtifact = false;
        this.iterationGainedInformation = false;
        // 第 69 波（修我自己上一波的 bug）：结束原因必须**每轮重置**。
        // 否则某轮失败（没有任何 finish_reason）时会沿用上一轮的 "length"，
        // 触发一次毫无意义的"续写" —— 事故现场就是这样把超限的上下文又撑大了 257/514 tokens。
        this.state.lastFinishReason = "stop";
        this.state.lastIterationTextChars = 0;
        /* 本轮的 LLM 失败标志必须每轮清空：否则第 N 轮的失败会泄漏到第 N+1 轮（误报 error） */
        this.state.lastIterationError = null;

        // P0-7.1 / 6.5建议2: 每轮迭代检查关键服务可用性
        if (!this.checkCriticalServices()) {
          const result: LoopResult = {
            type: "stop",
            reason: "critical_service_unavailable",
            usage: this.state.totalUsage,
          };
          yield { type: "text_delta", text: "\n\n⚠️ **关键服务不可用**，已停止执行。请在插件管理中检查 LLM/工具/消息存储服务是否正常加载。" };
          yield { type: "end", result };
          return result;
        }

        // P1-6.5建议3: 第一轮迭代时输出版本降级警告
        if (this.state.iteration === 1) {
          const warning = this.getDegradationWarning();
          if (warning) {
            yield { type: "text_delta", text: `\n${warning}\n` };
          }
        }

        // B3: Tick session skills — decrement TTL and unload expired skills
        try {
          const { tickSessionSkills } = await import("./tools/load-skill");
          await tickSessionSkills(sessionId, this.tools);
        } catch (err) {
          console.warn("[AgenticLoop] Failed to tick session skills:", err);
        }

        // P2-12: Goal continuation — check for blocked/in_progress goals
        //
        // 第 118 轮修正：这段原来**只 `console.log`、从不注入**。
        // 注释写着 "Inject goal status into the system prompt for LLM awareness"，
        // 而 `goalSummary` 算完就丢进了日志 —— 模型从头到尾没看到过目标。
        // 于是 `create_goal` 的 guidance 承诺「enable automatic continuation」是空话：
        // 目标建了、`update_goal` 也改了状态，但循环里没有任何一处会把它回灌给模型。
        //
        // 现在真正注入：在这里只**计算**，注入点是本迭代末尾那条**尾部 user 消息**
        // （与 time-context / surface notice 同一条路径）——
        // 尾部的构建在 time-context 旁边，那里已经确认 `apiMessages` 构建完毕。
        // （`apiMessages[0]` 在真实会话里**不是** system 消息，所以绝不能用
        //  `apiMessages[0].content += …` 这条路径；见 `extraSystemPrompt` 的说明。）
        if (this.state.iteration > 1) {
          try {
            const { listGoals } = await import("../goal/goal");
            const activeGoals = [
              ...listGoals(sessionId, "in_progress"),
              ...listGoals(sessionId, "blocked"),
            ];
            if (activeGoals.length > 0) {
              goalSummaryForPrompt = activeGoals
                .map((g: any) => {
                  const criteria = g.successCriteria
                    ? ` (success criteria: ${g.successCriteria})`
                    : "";
                  const note = g.blockedReason ? ` — blocked: ${g.blockedReason}` : "";
                  return `- [${g.status}] ${g.title}${criteria}${note}`;
                })
                .join("\n");
            }
          } catch (err) {
            // Goal system not available — non-critical
          }
        }

        // E8: Cost-aware degradation — degrade to cheaper model before hard stop
      if (this.config.costTracker) {
        const limits = (this.config.costTracker as any).config?.limits;
        const warningThreshold = this.config.costWarningThreshold ?? 0.8;
        const stopThreshold = this.config.costStopThreshold ?? 1.0;

        // Use perSession limit (fallback to total)
        const limit = limits?.perSession ?? limits?.total;
        if (limit) {
          // Get current session cost
          const sessionCost = this.config.costTracker.getTodayCost(); // Approximate — use today's cost as proxy
          const ratio = sessionCost / limit;

          // Hard stop: cost exceeds stop threshold
          if (ratio >= stopThreshold) {
            const result: LoopResult = {
              type: "stop",
              reason: `Cost limit exceeded: $${sessionCost.toFixed(4)} >= $${limit.toFixed(2)} (threshold: ${stopThreshold})`,
              usage: this.state.totalUsage,
            };
            if (this.config.memoryEnabled && this.config.onTurnComplete) {
              try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
            }
            telemetry.record(sessionId, "turn_end", { duration_ms: Date.now() - turnStartTime, reason: "cost_limit", totalTokens: this.state.totalUsage?.totalTokens || 0 });
            yield { type: "end", result };
            return result;
          }

          // Soft degradation: switch to cheaper model (compaction slot) when warning threshold reached
          if (ratio >= warningThreshold && !this.state.costDegraded && this.config.resolveProvider) {
            const degraded = this.config.resolveProvider("compaction");
            if (degraded && degraded.model !== this.config.model) {
              console.log(`[E8] Cost degradation: $${sessionCost.toFixed(4)}/$${limit.toFixed(2)} (${(ratio * 100).toFixed(0)}%), switching from ${this.config.model} to ${degraded.model}`);
              this.config.model = degraded.model;
              this.provider = degraded.provider;
              if (degraded.temperature !== undefined) {
                this.config.temperature = degraded.temperature;
              }
              this.state.costDegraded = true;
              yield {
                type: "text_delta",
                text: `\n\n⚠️ **成本降级**：当前会话费用已达上限的 ${(ratio * 100).toFixed(0)}%，已自动切换到更经济的模型 (${degraded.model}) 以控制成本。\n`,
              };
            }
          }
        }
      }

// 宏观步骤对齐：total 固定为计划宏步骤数。
// We do NOT grow total per iteration — intermediate tool calls (read,
// glob, grep, etc.) must not inflate the plan. Extra steps are appended
// later only when a genuinely new execution phase starts (see
// tool_start handling below).

      yield { type: "start", iteration: this.state.iteration };
      // 宏观步骤：从 1 开始；只读侦查工具不推进
      // NOT advance it. Execution tools (write/edit/bash/test) advance it
      // on first occurrence in an iteration (see tool_start handling).
      if (this.state.iteration === 1) {
        this.macroStep = 1;
        this.lastExecToolInIteration = null;
        this.appendedStepTitles.clear();
      }
      this.lastExecToolInIteration = null;
      yield { type: "step_progress", step: this.macroStep, total: this.activePlan.total, title: this.currentStepTitle(), steps: this.activePlan.plan };

      // Clear stale guidanceInterrupt flag — if we're at a new iteration with a
      // fresh AbortController, any previous guidance interrupt has been handled
      this.guidanceInterrupt = false;

      if (this.abortController.signal.aborted) {
        return { type: "aborted" };
      }

      const apiMessages = await this.buildMessages(sessionId);
      // P2/P4: Filter tool definitions based on runtime context.
      // - Plan mode: write/edit/multi_edit/tts/image_gen tools are hidden (enforced at registration layer)
      // - read_attachment: only available when conversation has document attachments
      //   (matches Wegent's ChatContext._build_extra_tools has_attachments pattern)
      // P0-2: Use core definitions (non-deferred) + deferred hints to save tokens.
      // Deferred tools (like lsp) are loaded on-demand via tool_search.
      const allToolDefs = this.tools.getCoreDefinitions();
      const deferredHints = this.tools.getDeferredDefinitions();
      const writeToolNames = new Set(["write", "edit", "multi_edit", "tts", "image_gen"]);

      // P4: Check if any message in this session has a document attachment.
      // read_attachment is useless without attachments — hiding it prevents the
      // LLM from hallucinating file content or calling it on plain text chats.
      const hasDocumentAttachment = this.checkHasDocumentAttachment(sessionId);
      const conditionalToolNames = new Set<string>();
      if (!hasDocumentAttachment) conditionalToolNames.add("read_attachment");

      const toolDefs = allToolDefs.filter(t => {
        // Filter by agent's toolAllowlist — ensures agents only see tools they're allowed to use
        if (!this.isToolAllowed(t.name)) return false;
        if (this.config.collaborationMode === "plan" && writeToolNames.has(t.name)) return false;
        if (conditionalToolNames.has(t.name)) return false;
        return true;
      });

      /**
       * 本轮要追加给模型的内容，两种落点 —— 判据是「内容会不会随时间变化」：
       *
       * - `extraSystemPrompt`：**稳定**内容（deferred 工具提示 / 技能提示）。进
       *   `executeIteration` 里真正构造出来的 system 消息尾部；每轮都一样 ⇒ 前缀缓存不受影响。
       * - `trailingTurnContext`：**易变**内容（时间戳 / 技能目录 / 活跃目标 / 表面状态）。
       *   作为**独立的尾部 user 消息**追加（与 DSH `context/time-context` 同形），
       *   稳定前缀（system + 历史）逐字节不变。
       *
       * ⚠️ 这两种落点取代的是原来那五处 `apiMessages[0].content += …`：
       * `apiMessages[0]` 在真实会话里**不是** system 消息（system 由 `executeIteration`
       * 单独构造，`messagesToLLMMessages` 明确丢掉 system 行），
       * 所以 `if (apiMessages[0].role === "system")` **恒为假** —— 这些注入曾经全是死代码，
       * 内容从来没到过模型（`goal-injection.test.ts` 曾经用源码文本把这种空转钉成"绿"）。
       */
      let extraSystemPrompt = "";
      let trailingTurnContext = "";

      /**
       * 第 94 波：**把"工作区里有哪些测试文件"当成事实摆一次**（每个会话一次）。
       *
       * 为什么加：234 对 DSH 唯一"对手稳定过、我们稳定不过"的格子是 `repo-02`，
       * 失败形状两版一致 —— 判据在 `dsh-d9-multi-edit-partial-failure.test.ts`，
       * 而 agent **读 1/3、跑 2/3**（既没读也没跑那条判据）。
       * `[RED TEST]` 指针的触发条件是"测试跑出红" ⇒ 没跑就没红 ⇒ 对这类**原理上无效** ✗。
       *
       * 与已被撤下的覆盖率唠叨（`c7feb4a`，在通过运行上 8/8 误报）的区别：
       * 这里**只呈递事实**（有哪些测试文件、共几个），不含任何"你应该跑更多"的判断 ✓
       * ⇒ 通过与不通过的运行看到的东西**完全一样**，不会造成选择性偏见 ✓。
       *
       * 走尾部消息而不是 system 前缀：与 time-context / goals / plan-context 同一形态，
       * 保持稳定前缀逐字节不变（`dsh-d5-prefix-cache-stability.test.ts` 守这条）。
       */
      /**
       * 第 97–98 波：**替它把"拿任务里的词搜仓库"这一步做了**（每个会话一次）。
       *
       * 为什么换掉第一版（列全部测试文件）：直接读对照臂（DSH）在 `repo-02` 上通过的那次会话，
       * 它的路径是 `grep "写入确认"` / `grep "classifyToolResult|applyToolResultStatus|isError"`
       * → **从命中的文件名里看出 `dsh-dN-*` 这个族** → 直接读 `dsh-d9-multi-edit-partial-failure.test.ts` ✓。
       * 而"平铺文件清单"在真实工作区里无效（496–4000+ 个测试文件，字母序前 40 全是 `aa-*` ✗；
       * 任务描述是中文、判据名是英文，词面排序也排不出来 ✗）。
       *
       * 现在两段都只陈述事实：① 用消息里的词在**测试文件**里搜，列出命中最多的（泛词按文档频率剔除）；
       * ② 给出测试文件的**命名分族**（赢家正是靠这个看出规律的 ✓）。
       */
      if (!this.testFileNoticeSent.has(sessionId)) {
        this.testFileNoticeSent.add(sessionId); // 先标记再做事：失败也不重试，避免每轮扫盘
        try {
          const { buildTaskSearchNotice } = await import("./task-keyword-search");
          const notice = await buildTaskSearchNotice(cwd, userMessage);
          /**
           * **第 116–118 波：把"成功还是 null"记下来**（排查痕迹，保留 ✓）。
           *
           * 排查期它用过 `console.info`（因为 `debugLog` 的开关是**模块加载时读一次**并缓存 ✗，
           * 而当时我连"这一行到底有没有执行"都不知道 ✗）。现在机制已被证明真的到模型 ✓
           * （装机版日志：`task-keyword search: 5743 chars | cwd=… | msgLen=165` ✓，
           * 与 Node 复算逐字对上 ✓），所以降级回 `debugLog` ✓ ——
           * 排查能力保留（`codem-debug=agent-loop` 可见 ✓），日常不再刷控制台 ✓。
           */
          debugLog(
            "agent-loop",
            "task-keyword search:",
            notice ? `${notice.length} chars` : "null",
            "| cwd=",
            cwd || "(空)",
            "| msgLen=",
            userMessage?.length ?? 0,
          );
          if (notice) {
            trailingTurnContext += (trailingTurnContext ? "\n\n" : "") + notice;
          }
        } catch (noticeErr) {
          // 非关键路径：搜索失败不该影响会话
          console.warn("[AgenticLoop] task-keyword search failed:", noticeErr);
        }
      }

      // P0-2: Inject deferred tool hints into system prompt so the LLM knows
      // these tools exist and can call tool_search to load them.
      if (deferredHints.length > 0) {
        const hintLines = deferredHints
          .map((t) => `  - ${t.name}: ${t.searchHint}`)
          .join("\n");
        const deferredPrompt =
          `\n\n## Deferred Tools (load on demand)\n` +
          `The following tools are available but not loaded by default to save tokens.\n` +
          `To use one, first call \`tool_search\` with the tool name, then use the tool.\n\n` +
          `${hintLines}\n`;
        extraSystemPrompt += deferredPrompt;
      }

      debugLog("agent-loop", `collaborationMode=${this.config.collaborationMode}, hasAttachment=${hasDocumentAttachment}, tools available: ${toolDefs.length}/${allToolDefs.length} (deferred: ${deferredHints.length})`, toolDefs.map(t => t.name));

      // B3: Inject pending skill prompts (from load_skill tool)
      const { consumePendingSkillPrompts, getLoadedSkillPrompts, tickSessionSkills } = await import("./tools/load-skill");
      const pendingSkillPrompt = consumePendingSkillPrompts(sessionId);
      if (pendingSkillPrompt) {
        // 进 system 消息尾部（见 extraSystemPrompt 的说明）：技能提示是**指令**，
        // 而且 `consumePendingSkillPrompts` 是一次性的 —— 若写进"一次性尾部消息"，
        // 下一轮就再也没人重新注入它。
        extraSystemPrompt += pendingSkillPrompt;
        console.log("[AgenticLoop] Injected skill prompt:", pendingSkillPrompt.length, "chars");
      }

      // Also inject already-loaded skill prompts (for context recovery after compaction)
      const activeSkillPrompt = getLoadedSkillPrompts(sessionId);
      if (activeSkillPrompt && !pendingSkillPrompt) {
        // 判据与旧实现一致（同一条 system 消息里不重复拼 "Active Skill Instructions"）；
        // 差别只是落点从"恒假的 apiMessages[0]"换成了本轮真正会发给 provider 的 extraSystemPrompt。
        if (!extraSystemPrompt.includes("Active Skill Instructions")) {
          extraSystemPrompt += activeSkillPrompt;
        }
      }

      // 差距 3: Catalog 每轮刷新 — digest 对比，变更才注入
      //
      // 落点是**尾部消息**（不是 system 前缀）：catalog 由 digest 门控，
      // 同一个会话的第二次请求通常返回空串 —— 若它进 system 前缀，
      // 同一会话两轮之间的 messages[0] 就不再逐字节相同，
      // `dsh-d5-prefix-cache-stability.test.ts` 守的前缀缓存判据当场失效。
      const { buildCatalogMessage } = await import("./tools/load-skill");
      const catalogMessage = await buildCatalogMessage(sessionId);
      if (catalogMessage) {
        trailingTurnContext += (trailingTurnContext ? "\n\n" : "") + catalogMessage;
        debugLog("agent-loop", "Injected skill catalog:", catalogMessage.length, "chars");
      }

      // 差距 2: /skill-name 用户手势 — 检测并自动加载技能
      const { processSkillGestures } = await import("./tools/load-skill");
      const gestureInjection = processSkillGestures(sessionId, userMessage);
      if (gestureInjection) {
        // 注入为用户消息（在消息列表末尾追加）
        apiMessages.push({
          role: "user",
          content: gestureInjection,
        });
        console.log("[AgenticLoop] Processed /skill-name gesture:", gestureInjection.length, "chars");
      }

      // R3-1.3: Time context — 每轮注入时间戳 + 时区 + 经过时间
      //
      // ## 第？波（前缀缓存 / 成本）：从 system 前缀搬到**尾部独立消息**
      //
      // 原实现是 `sysMsg.content += "\n\n" + timeContextMessage`，有两个问题：
      //
      // ① **判据本身是错的**：`apiMessages[0]` 在真实会话里不是 system 消息。
      //    system 消息由 `executeIteration` 单独构造（`messages: [{ role: "system", ... },
      //    ...processedMessages]`），而 `messagesToLLMMessages` 明确**丢掉** system 行
      //    （`message.ts`：「Skip system messages (they're handled separately)」）。
      //    于是这段注入（连同同一形态的 goals / surface notice）**从来没有生效过**。
      // ② 就算生效也是错的：注入文本含**秒级**时间戳，写进前缀 ⇒ 每一轮前缀都变一次
      //    ⇒ provider 的 prompt cache（KV cache）整段失效。DeepSeek 命中缓存的输入价
      //    约为未命中的 1/4 且快得多，所以这是纯粹的成本/延迟损失。
      //
      // 现在的形态与 DSH 的 `context/time-context` 对齐：**追加一条独立的尾部 user 消息**，
      // 并且**节流**（10 分钟，DSH 的默认 `refreshIntervalMs = 600_000`）——
      // 稳定前缀（system + 历史）逐字节不变，易变内容只出现在末尾。
      const { buildTimeContext } = await import("./time-context");
      const timeContextMessage = buildTimeContext(sessionId, this.state.iteration, 1, {
        refreshIntervalMs: TIME_CONTEXT_REFRESH_INTERVAL_MS,
      });
      if (timeContextMessage) {
        trailingTurnContext += timeContextMessage;
      }

      // P2-12（第 118 轮修正 / 第？波改走尾部消息）：把活跃目标真正注入给模型。
      //
      // 修之前这里只 `console.log`，模型看不到目标 —— 详见上面计算处的注释。
      // 措辞与 zcode 的 `resume_goal_state` / DSH 的目标提醒同取向：
      // **只陈述事实 + 明确「不要因此重复已完成的工作」**，
      // 而不是命令模型「继续做」（模型可能已经做完、只是状态没更新，
      // 硬命令会让它重复劳动）。
      //
      // ⚠️ 这一段**必须**走尾部消息（与时间上下文同一处置）。
      // 原来的形态是 `sysMsg.content += …`，被 `apiMessages[0].role === "system"` 守着，
      // 而真实会话里 `apiMessages[0]` **不是** system 消息 —— 所以那个 if 恒假，
      // 目标**从来没有到过模型**（`goal-injection.test.ts` 曾经用源码文本把这件事钉成"绿"）。
      // 目标文本也不该进 system 前缀：它随目标状态变化，写进去会整段击穿前缀缓存。
      //
      // 尾部消息是**每轮**临时构造的（不落库），而目标摘要在本轮开头每轮重算 ⇒
      // 只要目标还在，模型每一轮都能看到它（不存在"注入一次就丢"的问题）。
      if (goalSummaryForPrompt) {
        const goalSection =
          "# Active Goals\n\n" +
          "This session has goals that are still open:\n\n" +
          goalSummaryForPrompt +
          "\n\nIf the current work has already satisfied a goal's success criteria, " +
          "mark it complete with `update_goal` before finishing. " +
          "Do NOT redo work that is already done just because a goal is listed as in_progress — " +
          "check the actual state first. If a goal is genuinely blocked on something only the " +
          "user can provide, say so plainly instead of working around it.";
        trailingTurnContext += (trailingTurnContext ? "\n\n" : "") + goalSection;
      }

      // R3-3.1: Surface notice — 让模型知道当前上下文窗口状态
      //
      // 与时间上下文同一处置（第？波）：这段文本每轮都在变（可见消息数 / 事件总数），
      // 所以它只能出现在**尾部消息**里，绝不写进 system 前缀。
      // 原实现（`sysMsg.content += ...`）因为 ① 的判据错误从来没生效过；现在它真的
      // 会到达模型，但仍不碰前缀 —— 前缀稳定性是这条缺陷的核心判据。
      const { getSurfaceManager } = await import("./surface-manager");
      const surfaceNotice = getSurfaceManager().buildSurfaceNotice(sessionId);
      if (surfaceNotice) {
        trailingTurnContext += (trailingTurnContext ? "\n" : "") + surfaceNotice;
      }

      this.state.contextPressure = this.estimateContextPressure(apiMessages);

      let messagesForIteration = apiMessages;
      if (this.state.contextPressure > this.config.compactionThreshold && this.config.enableCompaction) {
        // Prevent infinite compaction loops (max 3 consecutive compactions)
        if (this.state.consecutiveCompactions >= 3) {
          console.warn("[AgenticLoop] Too many consecutive compactions, forcing stop");
          const result: LoopResult = {
            type: "overflow",
            message: "上下文窗口已满，即使压缩后仍无法继续。请开启新对话。",
            usage: this.state.totalUsage,
          };
          yield { type: "end", result };
          return result;
        }
        yield { type: "compaction_start" };
        const compacted = await this.compactMessages(sessionId);
        yield { type: "compaction_end", messagesRemoved: compacted };
        // P1-6: Clear transcript cache on compaction (cached responses no longer valid)
        TranscriptCache.clear();

        // P2-C: Post-compaction cleanup — clear stale caches
        // After compaction, old file read/write caches are stale because the
        // conversation history they were based on has been summarized.
        // The LLM may re-read files it needs, so we clear caches to prevent
        // false cache hits on files that may have changed context.
        this.readCache?.clear();
        this.writeCache?.clear();
        this.msgCache = null;
        this.state.microCompactedThisRun = false;
        // F1.2: Trigger memory extraction after compaction
        if (this.config.memoryEnabled && this.config.onCompactionComplete) {
          try { this.config.onCompactionComplete(); } catch (e) { console.warn('[agentic-loop.ts]', e) }
        }
        messagesForIteration = await this.buildMessages(sessionId);
        this.state.compactedThisIteration = true;
        this.state.consecutiveCompactions++;
      } else {
        // Reset consecutive compactions if no compaction needed
        this.state.consecutiveCompactions = 0;
      }

      // === Guidance injection (mid-turn steering) ===
      // Consume one guidance item from the queue at this iteration boundary.
      // This is the ONLY injection point — safe because:
      // 1. Previous iteration's tools have fully completed
      // 2. We're about to call the LLM, so the model will see it immediately
      // 3. The message is ephemeral — NOT persisted to the message database
      // 4. Does not corrupt msgCache (we create a new array, cache is untouched)
      // 5. Does not interfere with wait_for_subagent (that runs inside tools)
      const guidanceItem = this.guidanceQueue.consume(sessionId);
      if (guidanceItem) {
        const guidanceMsg = {
          id: `guidance-${guidanceItem.id}`,
          role: "user" as const,
          content: GUIDANCE_MESSAGE_TEMPLATE(guidanceItem.message),
        };
        messagesForIteration = [...messagesForIteration, guidanceMsg];
        console.log(
          `[AgenticLoop] Injected guidance ${guidanceItem.id} at iteration ${this.state.iteration}: "${guidanceItem.message.substring(0, 80)}..."`
        );
        yield {
          type: "guidance_received",
          message: guidanceItem.message,
          guidanceId: guidanceItem.id,
        };
      }

      // R3-B10: Consume pending agent messages at iteration boundary
      // Agent messages are similar to guidance — injected as user-role context
      try {
        const { AgentMessageQueue } = await import("./agent-message-queue");
        const pendingMessages = AgentMessageQueue.consume("primary");
        if (pendingMessages.length > 0) {
          const agentMsgContent = pendingMessages.map(m =>
            `[Agent: ${m.fromAgent} → ${m.toAgent}] ${m.subject}: ${m.body}`
          ).join("\n\n");
          const agentMsg = {
            id: `agent-msg-${Date.now()}`,
            role: "user" as const,
            content: agentMsgContent,
          };
          messagesForIteration = [...messagesForIteration, agentMsg];
          console.log(`[AgenticLoop] Injected ${pendingMessages.length} agent message(s) at iteration ${this.state.iteration}`);
        }
      } catch {
        // Agent message queue not available — non-critical
      }

      /**
       * 易变上下文（时间戳 / 表面状态）统一作为**独立的尾部 user 消息**注入。
       *
       * 这是 FIX 的核心判据：稳定前缀（system 消息 + 历史消息）与上一轮**逐字节相同**，
       * 于是 provider 的前缀缓存（DeepSeek 的 KV cache）能命中；易变文本只出现在末尾。
       * 与 DSH `context/time-context` 的形态一致（它也是 append 一条 user 消息）。
       *
       * 放在所有其他注入（guidance / agent message）**之后**：这样"稳定前缀"尽可能长。
       * 该消息是**每轮临时构造**的（不落库），所以不会污染下一轮的历史。
       */
      /**
       * 计划上下文（当前执行计划 + 进行到第几步）：**每轮重算**，作为独立的尾部
       * user 消息注入。
       *
       * 为什么是尾部消息而不是 system 前缀：`renderPlanSection(plan, macroStep)` 的
       * 两半输入在**同一轮**内都会变（`macroStep` 随执行类工具推进、
       * `activePlan.plan` 被 `update_plan` 改写），写进 `messages[0]` 就会让同一轮
       * 第 2 次请求的前缀与第 1 次不同 ⇒ provider 前缀缓存整段失效
       * （判据见 `dsh-d5-prefix-cache-stability.test.ts`；本轮的覆盖测试是
       * `dsh-d5b-plan-prefix-stability.test.ts`）。
       *
       * 放在 `trailingTurnContext` **之前**：这样「最后一条消息」仍然是易变上下文
       * （时间戳等），D5 的「易变内容只在尾部」判据与位置断言都不受影响；
       * 计划段同样是**每轮临时构造、不落库**的（下一轮重新渲染，不会累积）。
       */
      const planContext = renderPlanSection(this.activePlan.plan, this.macroStep);
      if (planContext) {
        messagesForIteration = [
          ...messagesForIteration,
          {
            id: `plan-context-${this.state.iteration}`,
            role: "user" as const,
            content: planContext,
          },
        ];
      }

      if (trailingTurnContext) {
        messagesForIteration = [
          ...messagesForIteration,
          {
            id: `turn-context-${this.state.iteration}`,
            role: "user" as const,
            content: trailingTurnContext,
          },
        ];
      }

      // Execute iteration - yields events directly for real-time streaming
      let iterationToolCalls = 0;
      let iterationHadText = false;
      const spawnTaskIds: string[] = [];

      // P0: Start file change tracking at iteration boundary (before tools)
      // P1: 检查 fileChangeTracker Provider 服务可用性（对标 DSH 模式）
      // 第 58 波：这句话原本每一轮迭代都输出一次；回退本身是设计好的容错，只需知道一次。
      const trackerSvc = this.getFileChangeTrackerService();
      if (!trackerSvc) {
        warnOnce('svc:fileChangeTracker', '[AgenticLoop] Service "fileChangeTracker" not available from ctx, creating standalone instance');
      }
      this.fileChangeTracker = new FileChangeTracker(
        // 同一套口径（O-28）：这一轮的改动记在**消息存储里那一行**的 id 上，
        // 与 tool_calls / 事件日志一致；落库方没接线时才用引擎自造的 id。
        cwd, sessionId, this.resolveMessageIdForTools(sessionId, assistantMsgId), this.state.iteration,
      );
      await this.fileChangeTracker.start();
      /**
       * **第 132 波：把"每轮的时间花在哪"记下来**（`codem-debug=agent-loop` 时才输出 ✓）。
       *
       * 起因：1.16.246 的时延是对手的 1.47× ✗，而**应用侧的工具落库间隔≈0s** ✓
       * ⇒ 时间要么在"调模型之前应用自己做的事" ✗，要么在"模型流式" ✗ —— 这两者必须分开量 ✓。
       * 下面把一轮切成 `准备`（到 `executeIteration` 之前）与 `模型`（流式全过程）两段 ✓。
       */
      const iterT0 = Date.now();
      const iterNo = this.state.iteration;
      for await (const event of this.executeIteration(
        sessionId,
        assistantMsgId,
        messagesForIteration,
        toolDefs,
        cwd,
        systemPrompt,
        extraSystemPrompt,
      )) {
        // update_plan 工具修改计划后，先推送一次刷新事件，让 UI 的
        // "第X/X步"与完整步骤列表立即同步（对标 dsh todo 动态插入）。
        if (this.planDirty) {
          this.planDirty = false;
          yield { type: "step_progress", step: this.macroStep, total: this.activePlan.total, title: this.currentStepTitle(), steps: this.activePlan.plan };
        }
        yield event;
        if (event.type === "tool_start") iterationToolCalls++;
        if (event.type === "text_delta" && event.text.trim()) iterationHadText = true;

// 宏观步骤推进：
// - Recon tools (read/glob/grep/tool_search/web_search/list) 与计划元操作
//   (update_plan) 不推进步骤。
// - The FIRST execution tool (write/edit/bash/run_test/etc.) in an iteration advances to the next macro step.
// - Extra steps are appended only when the planned steps are exhausted and a new execution phase starts.
if (event.type === "tool_start") {
const toolName = event.toolCall.name;
const isRecon = RECON_TOOL_NAMES.has(toolName);
if (!isRecon && this.lastExecToolInIteration === null) {
this.lastExecToolInIteration = toolName;
this.lastExecToolName = toolName;
const planLen = this.activePlan.plan?.length ?? 0;
if (this.macroStep < planLen) {
// 计划内：执行类工具首次出现 → 推进到下一宏步骤（每个 iteration 至多一次）
this.macroStep++;
} else if (planLen > 0 && this.macroStep >= planLen && !this.activePlan.fromLlm) {
// 计划耗尽（仅启发式兜底计划）：宏观计划步语义 — 中间小步骤不会新增步骤；
// 只有出现新的执行类别时才追加一步（标题去重 + 总数受限），防止膨胀。
// LLM 语义计划不在此自动追加 —— 模型应通过 update_plan 插入语义步骤，
// 避免再次出现"执行命令"这类与任务无关的泛化标题。
const appendTitle = this.getToolTitle(toolName);
if (AgenticLoop.shouldAppendStep(this.appendedStepTitles, toolName)) {
this.appendedStepTitles.add(appendTitle);
if (this.activePlan.plan) {
this.activePlan.plan.push({ title: appendTitle });
this.activePlan.total = this.activePlan.plan.length;
}
this.macroStep++;
}
}
}
yield { type: "step_progress", step: this.macroStep, total: this.activePlan.total, title: this.currentStepTitle(), steps: this.activePlan.plan };
}
// DSH-style: 不再需要追踪 spawn_subagent 的工具启动事件
      }
      // P0: Finalize file change tracking after tools complete
      if (this.fileChangeTracker) {
        const changeResult = await this.fileChangeTracker.finalize();
        if (changeResult) {
          yield {
            type: "file_changes_tracked",
            artifactId: changeResult.artifactId,
            changedFiles: changeResult.changedFiles,
            turnIndex: this.state.iteration,
          };
        }
        this.fileChangeTracker = null;
        // P1-5: Try auto-commit if enabled (after file changes tracked)
        tryAutoCommit(cwd).catch((e) => {
          console.warn("[AgenticLoop] auto-commit failed:", e);
        });
      }
      // P1-8: Check needs_you queue at iteration boundary (Agent→Human)
      const needsYouItem = this.needsYouQueue.consume(sessionId);
      if (needsYouItem) {
        yield {
          type: "needs_you",
          question: needsYouItem.question,
          context: needsYouItem.context,
          confirmedFacts: needsYouItem.confirmedFacts,
          options: needsYouItem.options,
          itemId: needsYouItem.id,
        };
        // Pause and wait for user answer
        const answer = await this.needsYouQueue.waitForAnswer(needsYouItem.id);
        // Inject answer as user message for next iteration
        if (answer && answer !== "__skip__") {
          const answerMsg = {
            id: `needs-you-answer-${needsYouItem.id}`,
            role: "user" as const,
            content: `[User Decision] ${needsYouItem.question}\n\nAnswer: ${answer}\n\nContinue with this decision.`,
          };
          messagesForIteration = [...messagesForIteration, answerMsg];
          this.msgCache = null;
        }
      }
      // P2-10: Consume async agent messages at iteration boundary
      const messages = AgentMessageQueue.consume(this.agentId);
      if (messages.length > 0) {
        for (const msg of messages) {
          yield {
            type: "agent_message_received",
            fromAgent: msg.fromAgent,
            subject: msg.subject,
            body: msg.body,
          };
          // Inject message content for LLM to see
          const msgContent = `[Message from ${msg.fromAgent}] Subject: ${msg.subject}\n\n${msg.body}`;
          const agentMsg = {
            id: `agent-msg-${msg.id}`,
            role: "user" as const,
            content: msgContent,
          };
          messagesForIteration = [...messagesForIteration, agentMsg];
          this.msgCache = null;
        }
      }
      // Don't overwrite toolCallsInIteration if executeIteration already
      // determined that ALL tool calls were cache hits (set to 0).
      // iterationToolCounts counts raw tool_start events (before cache detection),
      // so it would incorrectly restore a non-zero value and prevent the loop
      // from checking stop conditions.
      if (this.state.toolCallsInIteration > 0) {
        this.state.toolCallsInIteration = iterationToolCalls;
      }
      debugLog("agent-loop", `Iteration ${this.state.iteration} completed: ${iterationToolCalls} tool calls (effective: ${this.state.toolCallsInIteration}), ${this.state.consecutiveErrors} consecutive errors`);
      // Runaway detection: track whether this iteration made any progress.
      // Progress = text output OR at least one effective tool call.
      // 第 62 波（审计修正）：被守卫拦下的调用不算"有效工具调用" ——
      // 它们只是走了一遍事件（tool_start/tool_complete），并没有真的做事。
      // 不扣掉的话，"抑制"反而会让无进展阀门永远不触发（原地打转变成不会结束的循环）。
      const effectiveToolCalls = Math.max(0, this.state.toolCallsInIteration - this.guardSuppressedThisIteration);
      if (iterationHadText || effectiveToolCalls > 0) {
        this.state.consecutiveNoProgress = 0;
      } else {
        this.state.consecutiveNoProgress++;
      }
      // 第 65 波（审计修正）：停滞检测放在"重复调用守卫停止"**之后** ——
      // 否则两者在同一迭代同时成立时，会先注入一条"进度自查"用户消息、紧接着循环就停了，
      // 留下一条没有下文的孤儿消息（用户会看到一条突兀的系统提醒）。
      // 先让"停"的决定生效，再考虑"问"。
      if (!this.guardStopMessage) {
        const stall = this.stallGuard.noteIteration({
          planRevision: this.planRevision,
          producedArtifact: this.iterationProducedArtifact,
          gainedInformation: this.iterationGainedInformation,
          stepLabel: this.currentStepTitle(),
        });
        if (stall.action === "ask") {
          console.warn(`[AgenticLoop] Plan stall detected (${stall.stalledFor} iterations with no plan revision, no artifact and no new information) — asking the model instead of stopping`);
          try {
            this.getMessageStorage().createMessage({
              id: `stall-ask-${Date.now()}`,
              role: "user",
              content: stall.message ?? "",
              timestamp: Date.now(),
              status: "done",
            }, sessionId);
            this.msgCache = null;
            recordLoopStop(sessionId, "plan_stale_ask", { stalledFor: stall.stalledFor, planRevision: this.planRevision, noGainStreak: this.repeatGuard.noGainStreakCount });
          } catch (e) { console.warn('[agentic-loop.ts]', e) }
          yield { type: "text_delta", text: `\n\n⏳ **进度自查**：已连续 ${stall.stalledFor} 个迭代没有拿到新信息、也没有产出交付物，正在要求模型说明卡点…` };
        } else if (stall.action === "stop") {
          console.warn(`[AgenticLoop] Plan stall stop after ${stall.stalledFor} iterations`);
          recordLoopStop(sessionId, "plan_stale", { stalledFor: stall.stalledFor, planRevision: this.planRevision, noGainStreak: this.repeatGuard.noGainStreakCount });
          yield { type: "text_delta", text: `\n\n⚠️ **检测到停滞，已停止**：${stall.message ?? ""}` };
          const result: LoopResult = {
            type: "stop",
            reason: "plan_stale",
            usage: this.state.totalUsage,
            // 第 93 波：把停滞量级带出去 —— 界面要能说清「因停滞而停止」，
            // 而不是把一次被杀掉的循环呈现成「任务完成」（见 turn-outcome.ts / pet-store.ts）。
            detail: {
              stalledFor: stall.stalledFor,
              planRevision: this.planRevision,
              noGainStreak: this.repeatGuard.noGainStreakCount,
            },
          };
          if (this.config.memoryEnabled && this.config.onTurnComplete) {
            try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
          }
          yield { type: "end", result };
          return result;
        }
      }

      // 第 62 波：重复调用守卫判定「原地打转」→ 立刻收手（而不是让模型自己醒悟）
      // 与 writeRejected 同一形态：状态标记 + 终止循环 + 给用户看得懂的一句话。
      if (this.guardStopMessage) {
        const stats = this.repeatGuard.stats;
        // 显式标注类型：guardStopKind 是在工具回调里被赋值的，TS 的控制流分析只看到 run() 开头那次赋值
        const stopKind = this.guardStopKind as GuardKind;
        console.warn(
          `[AgenticLoop] Repeat guard stopped the loop (${stopKind}) — noGainRepeats=${stats.noGainRepeats}, distinctResults=${stats.distinctResults}, suppressed=${stats.suppressed}, advisories=${stats.advisories}`,
        );
        const headline =
          stopKind === "enumerate"
            ? "⚠️ **检测到原地打转，已停止**（同一目标被反复只读枚举）"
            : "⚠️ **检测到原地打转，已停止**（连续拿到完全相同的内容 = 零信息增益）";
        yield { type: "text_delta", text: `\n\n${headline}：${this.guardStopMessage}` };
        // 统一走 recordLoopStop（第 65 波）：reason 用 no_gain 归类，便于统计"哪种卡法最多"
        recordLoopStop(sessionId, "no_gain", {
          kind: stopKind,
          noGainRepeats: stats.noGainRepeats,
          distinctResults: stats.distinctResults,
          suppressed: stats.suppressed,
          advisories: stats.advisories,
        });
        const result: LoopResult = {
          type: "stop",
          reason: "repeat_guard",
          usage: this.state.totalUsage,
        };
        if (this.config.memoryEnabled && this.config.onTurnComplete) {
          try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
        }
        yield { type: "end", result };
        return result;
      }

      // S4: If a write was rejected by the user, stop the loop immediately
      // This prevents the LLM from retrying the write in subsequent iterations
      if (this.state.writeRejected) {
        yield { type: "text_delta", text: "\n\n⚠️ **写入已被拒绝**。用户未确认文件覆盖，已停止执行。如需重新写入，请重新发送指令。" };
        const result: LoopResult = {
          type: "stop",
          reason: "write_rejected_by_user",
          usage: this.state.totalUsage,
        };
        if (this.config.memoryEnabled && this.config.onTurnComplete) {
          try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
        }
        yield { type: "end", result };
        return result;
      }

      // 第？波：**流中途被取消不是"完成"**。
      //
      // 用户点 ■ 时，provider 侧的 `reader.cancel()` 会让挂起的 `read()` 以
      // `{done:true}` 正常返回（不抛 AbortError），于是"取消"看起来和"服务端正常收尾"
      // 一样。provider 现在会把这种收尾标成 `finishReason: "aborted"`；循环据此
      // 如实上报取消 —— 判据必须**在 completed 分支之前**，否则这一轮照样会被
      // 当成 reason 为 completed 的正常收尾（用户按了停止，界面却说完成）。
      if (this.state.lastFinishReason === "aborted") {
        if (this.guidanceInterrupt) {
          /*
           * 这次中止**不是用户取消**，而是"立刻插入指引"（`sendGuidanceImmediate` /
           * `interruptForGuidance`）故意打断当前流 —— 目的是让循环马上进入下一轮消费指引。
           * 所以只清标志、不报 aborted，让下面 completed 分支的
           * `guidanceQueue.hasPending → continue` 生效（与 AbortError 路径同一语义）。
           */
          console.log(`[AgenticLoop] Stream aborted for immediate guidance — continuing to consume guidance`);
          this.guidanceInterrupt = false;
        } else {
          console.log(`[AgenticLoop] Stream was cancelled mid-flight (finishReason=aborted) — reporting aborted instead of completed`);
          const abortedResult: LoopResult = { type: "aborted" };
          yield { type: "end", result: abortedResult };
          return abortedResult;
        }
      }

      // Check if we should continue
      if (this.state.toolCallsInIteration === 0 && !this.state.compactedThisIteration) {
        // === Guidance pending check ===
        // If there are pending guidance messages (e.g., from immediate injection),
        // continue the loop to let them be consumed at the next iteration boundary.
        if (this.guidanceQueue && this.guidanceQueue.hasPending(sessionId)) {
          console.log(`[AgenticLoop] Pending guidance detected — continuing loop instead of stopping`);
          continue;
        }
        // DSH-style: settlement 通过 Promise 网关等待，而非轮询检查/注入提醒。
        // SubagentRuntime 在 dispose 时 resolve settlement Promise，
        // agentic-loop 在此 await 它，settlement 通知已写入 DB，
        // 下一轮 buildMessages 自然看到通知内容。
        if (this.pendingBackgroundSubagents.size > 0) {
          // 清理已 settled 的条目（由 resolveSubagentSettlement 标记）
          const settledIds: string[] = [];
          const pendingPromises: Promise<void>[] = [];
          for (const [subId, promise] of this.pendingBackgroundSubagents) {
            if (this.settledSubagentIds.has(subId)) {
              settledIds.push(subId);
            } else {
              pendingPromises.push(promise);
            }
          }
          for (const id of settledIds) {
            this.pendingBackgroundSubagents.delete(id);
            this.settlementResolvers.delete(id);
            this.settledSubagentIds.delete(id);
          }
          // 如果仍有未 settled 的子智能体，await 它们的 settlement
          if (pendingPromises.length > 0) {
            console.log(`[AgenticLoop] Awaiting ${pendingPromises.length} background subagent settlement(s) — no polling, no injection.`);
            // 等待至少一个 settlement 到达
            await Promise.race(pendingPromises).catch(() => {});
            // settlement 到达后，通知已写入 DB，下一轮 buildMessages 自然看到
            // 不需要注入任何提醒消息
            continue;
          }
        }
        // Delegation guard: check if there are delegated tasks (cross-session)
        // that haven't been waited on yet.
        if (this.delegatedTasks.size > 0) {
          const unwaitedDelIds = Array.from(this.delegatedTasks);
          const delTaskList = unwaitedDelIds.map(id => `  - task_id: "${id}"`).join("\n");
          const delReminder = `[SYSTEM REMINDER] You have ${unwaitedDelIds.length} delegation task(s) that were sent but NOT collected. You MUST call wait_for_delegation for each task ID below to collect their results.\n\nUn-waited delegation task IDs:\n${delTaskList}\n\nCall wait_for_delegation(task_id: "...") for EACH task ID above. Do NOT finish without collecting results.`;
          // C5: EventLog dual-write for delegation reminder will follow
          this.getMessageStorage().createMessage({
            id: `del-reminder-${Date.now()}`,
            role: "user",
            content: delReminder,
            timestamp: Date.now(),
            status: "done",
          }, sessionId);
          this.msgCache = null;
          console.warn(`[AgenticLoop] ${unwaitedDelIds.length} un-waited delegation(s) — injected wait_for_delegation reminder instead of stopping. IDs: ${unwaitedDelIds.join(", ")}`);
          continue;
        }
        // ===== 第 68 波：回复被输出上限截断时**自动续写**，而不是当成"正常完成" =====
        //
        // 真实事故：用户说"继续之前没完成的任务"，一轮之后循环就结束了
        // （日志里只有 `Single-response dedup: 0 tool calls` 然后直接进入记忆抽取），
        // 表现就是"任务又中断了"。原因：`finish_reason === "length"`（达到单次输出上限）
        // **以前只用于内容型工具的提示**，从不参与"要不要停"的判断 —— 于是被截断的回复
        // （尤其是纯文本、没有工具调用的那种）被当成写完了。
        //
        // 现在：截断 ⇒ 注入一条"从断点继续"的提示并继续循环（预算 3 次）；
        // 预算用完 ⇒ 明确停下来并告诉用户该怎么做（分块 / 提高上限）。
        if (this.state.lastFinishReason === "length") {
          if (this.truncatedContinuations < MAX_TRUNCATED_CONTINUATIONS) {
            this.truncatedContinuations++;
            recordLoopStop(sessionId, "output_truncated", {
              phase: "auto-continue",
              continuation: this.truncatedContinuations,
              iteration: this.state.iteration,
            });
            console.warn(
              `[AgenticLoop] Response was truncated (finish_reason=length) — auto-continuing (${this.truncatedContinuations}/${MAX_TRUNCATED_CONTINUATIONS})`,
            );
            // 第 69 波：区分"接不上"与"**正文 0 字符**"。
            // 事故现场（iteration 1）就是 `finish_reason=length, text 0 chars, tool calls 0` ——
            // 带思考的模型把整个输出预算花在 reasoning 上，正文一个字都没出来。
            // 这种情况下要它"从断点继续"是没用的（没有断点），必须明确要求"少想、直接产出"。
            const reasoningOnly = this.state.lastIterationTextChars === 0;
            try {
              this.getMessageStorage().createMessage({
                id: `trunc-cont-${Date.now()}`,
                role: "user",
                content: reasoningOnly
                  ? `[SYSTEM] 你上一条回复因为**达到单次输出上限**被截断了（finish_reason=length），` +
                    `而且**正文一个字都没输出** —— 输出预算大概率被"思考"用光了。\n` +
                    `请**立刻停止过度思考**，直接产出：少分析、少铺垫，先把要写的文件（\`write\`，长文件用首段 + \`append: true\`）` +
                    `或要执行的命令发出来，再补必要的说明。\n` +
                    `不要重新开始整个任务。`
                  : `[SYSTEM] 你上一条回复因为**达到单次输出上限**被截断了（finish_reason=length）。请**从断点继续**：\n` +
                    `  · **不要重复**已经输出过的内容，直接从断掉的地方往下写；\n` +
                    `  · 如果要写的是长文件/长脚本，请改用**分块落盘**：\`write\` 写第一段，之后每次用 \`write\` + \`append: true\` 追加（每段建议 ≤200 行）；\n` +
                    `  · 如果上一步其实已经写完，直接说明"已完成"并给出结论；\n` +
                    `  · 不要重新开始整个任务。`,
                timestamp: Date.now(),
                status: "done",
              }, sessionId);
              this.msgCache = null;
            } catch (e) { console.warn('[agentic-loop.ts]', e) }
            yield {
              type: "text_delta",
              text: reasoningOnly
                ? "\n\n⏩ 上一条回复只输出了思考、正文为空就撞到输出上限，已要求它直接产出…\n\n"
                : "\n\n⏩ 上一条回复因达到输出上限被截断，正在自动续写…\n\n",
            };
            continue;
          }
          // 连续被截断：停下来说清楚，别让用户以为任务"自己断了"
          recordLoopStop(sessionId, "output_truncated", {
            phase: "give-up",
            continuations: this.truncatedContinuations,
          });
          yield {
            type: "text_delta",
            text:
              `\n\n⚠️ **已连续 ${this.truncatedContinuations} 次在单次输出上限处被截断**，为避免无限续写已停止。\n` +
              `建议：① 让它把长文件**分块写入**（\`write\` 首段 + \`write append: true\` 追加）；` +
              `② 或把这个模型/智能体的输出上限调大（设置 → maxTokens）。`,
          };
          const truncResult: LoopResult = {
            type: "stop",
            reason: "output_truncated",
            usage: this.state.totalUsage,
          };
          if (this.config.memoryEnabled && this.config.onTurnComplete) {
            try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
          }
          yield { type: "end", result: truncResult };
          return truncResult;
        }

        // No un-waited sub-agents — safe to stop
        //
        // 但在"可以停"之前必须先排除两种**不是完成**的收场（它们原来都被这一分支
        // 抢先当成 completed 返回，于是下面 `:1878` 的 too_many_errors 与
        // `LoopResult` 里的 `type: "error"` 都是死代码）：
        //
        // ① 连续错误到达上限（LLM 调用失败恒定让 toolCallsInIteration 留在 0，
        //    所以这条判据在 LLM 失败路径上**只能在这里**被看到）；
        if (this.state.consecutiveErrors >= this.config.maxConsecutiveErrors) {
          const errResult: LoopResult = {
            type: "stop",
            reason: "too_many_errors",
            usage: this.state.totalUsage,
          };
          if (this.config.memoryEnabled && this.config.onTurnComplete) {
            try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
          }
          yield { type: "end", result: errResult };
          return errResult;
        }
        // ② 本迭代的 LLM 调用最终失败（重试已耗尽 / 不可重试的 4xx）。
        //    失败就是失败：绝不作为 "completed" 上报（那会让调用方、用量记账、
        //    界面全部以为这一轮成功了）。
        if (this.state.lastIterationError !== null) {
          console.error(
            `[AgenticLoop] LLM call failed for iteration ${this.state.iteration} — reporting error instead of completed: ${this.state.lastIterationError}`,
          );
          const failResult: LoopResult = { type: "error", error: this.state.lastIterationError };
          if (this.config.memoryEnabled && this.config.onTurnComplete) {
            try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
          }
          yield { type: "end", result: failResult };
          return failResult;
        }

        /**
         * **第 154/156 波：收尾时点出"族里没跑过的判据"** ✓ —— 目标①的正面突破点 ✓。
         *
         * ## 为什么是"族"而不是"共享符号"（先验前提查出来的 ✗→✓）
         *
         * 第 154 波先做的是"同族判据 = 与所改文件**共享符号**的判据"✗，先验前提一量就发现**是哑的** ✗：
         * `tools.ts` 只找得到 `dsh-d10`（**已经跑过的那条** ✗），漏掉 `dsh-d8` / `dsh-d9` ✗；
         * 两次放宽都还是找不到 ✗。而真机读数早就指出差别是「**同一族跑了几条**」✓：
         * 通过轮跑了整个 `dsh-*` 族 ✓，失败轮只跑了一条 ✗。
         *
         * ## 为什么提醒里要带**计数**
         *
         * 族可能有十几条 ✓（`dsh` 族实测 18 条 ✓），只列前 8 条（按名字排 ✗）**又会漏掉 d8/d9** ✗。
         * 所以这里说清 **总数/跑过/没跑** ✓，并给出**一条能跑完整个族的命令** ✓ ——
         * 让模型知道"缺口有多大" ✓，而不是被一份截断的清单误导 ✗。
         */
        if (!this.unrunSiblingsNudged && this.sessionEditedSources.size > 0 && this.testFileStatus.size > 0) {
          try {
            const { unrunFamilyCriteria } = await import("./task-keyword-search");
            const root = this.lastCwd || process.cwd();
            /** 上限放到 50 ✓：这里只是"够不够看清缺口"✓，不按名字砍在前 8 条 ✗。 */
            const unrun = await unrunFamilyCriteria({ root, runFiles: [...this.testFileStatus.keys()], max: 50 });
            if (unrun.length > 0) {
              this.unrunSiblingsNudged = true;
              const ranFamilies = [...this.testFileStatus.keys()].map((f) => (f.split("/").pop() ?? f).split(/[-_.]/)[0]);
              const family = ranFamilies[0] ?? "（同族）";
              debugLog("agent-loop", "收尾：族里没跑过的判据", { family, unrun: unrun.length, sample: unrun.slice(0, 3) });
              recordLoopStop(sessionId, "completed_unverified", { phase: "unrun-family", iteration: this.state.iteration });
              const shown = unrun.slice(0, 8);
              this.getMessageStorage().createMessage(
                {
                  id: `unrun-family-nudge-${Date.now()}`,
                  role: "user",
                  content:
                    "[SYSTEM] 你这一路改过源码，而**判据只跑了一部分**（这是一条事实，不是命令 ✓）：\n" +
                    `- 你已经跑过 ${this.testFileStatus.size} 条 ✓\n` +
                    `- 同族（\`${family}-*\`）里还有 **${unrun.length} 条你没跑过**：\n` +
                    shown.map((f) => `  - ${f}`).join("\n") +
                    (unrun.length > shown.length ? `\n  - …还有 ${unrun.length - shown.length} 条` : "") +
                    `\n\n一条命令可以把整族跑完：\`npx vitest run 'src/test/${family}-*.test.ts'\` ✓\n` +
                    "为什么值得跑完：这类任务的真机数据里，**把同族判据跑齐的轮次通过，只跑了一部分的轮次失败** ✓，" +
                    "而失败形态几乎都是「改得不完整」（只补了其中一两处）✓。",
                  timestamp: Date.now(),
                  status: "done",
                },
                sessionId,
              );
              this.msgCache = null;
              yield {
                type: "text_delta",
                text: `\n\n🔎 同族判据还有 ${unrun.length} 条没跑过（已跑 ${this.testFileStatus.size} 条），已要它先跑完再收尾…\n\n`,
              };
              continue;
            }
          } catch (e) {
            warnOnce("unrun-family", "[agentic-loop] 族判据收尾检查失败", e);
          }
        }

        /**
         * 【本轮新增】**「改了但没验证」不许安静地当作完成。**
         *
         * 真机反馈与本次实测都是这个形状：模型改完文件、一次验证都没跑，界面就报「任务完成」，
         * 而缺陷还在（实测：38 次工具调用、报完成、判据 3/7 红）。
         *
         * 处理分两步，都**不改变 `reason`**（下游按 `completed` 匹配的地方很多，改它会连锁）：
         * ① 先提示一次，让它自己去验证（花一轮，换"真的做对了"通常是划算的）；
         * ② 仍然不验证就**明说"这一轮未经证实"**，让用户与调用方都看得见。
         */
        if (this.turnEditsAfterVerification || (this.turnModifiedFiles && !this.turnRanVerification)) {
          if (!this.verificationNudgeIssued) {
            this.verificationNudgeIssued = true;
            recordLoopStop(sessionId, "completed_unverified", { phase: "nudge", iteration: this.state.iteration });
            try {
              this.getMessageStorage().createMessage(
                {
                  id: `verify-nudge-${Date.now()}`,
                  role: "user",
                  content:
                    "[SYSTEM] 你在这一轮里**改动了文件，但最后一次改动之后没有再运行验证**" +
                    "（测试 / 构建 / 类型检查）。\n" +
                    "注意：**之前跑过验证不算** —— 后来的改动会让那次验证失效（真机实测：" +
                    "某轮读也读了、跑也跑了，然后以一次 write 收尾，缺陷就留在盘上）。\n" +
                    "在宣布完成之前请**实际验证**：跑相关测试或最小复现，看到它真的通过。\n" +
                    "如果这个改动无法用命令验证，就**明确说明你是怎么确认它对**的，" +
                    "不要把未经证实的改动说成已完成。",
                  timestamp: Date.now(),
                  status: "done",
                },
                sessionId,
              );
              this.msgCache = null;
            } catch (e) {
              console.warn("[agentic-loop.ts]", e);
            }
            yield {
              type: "text_delta",
              text: "\n\n🔎 这一轮改动过文件但**没有验证**，已要求它先跑验证再收尾…\n\n",
            };
            continue;
          }
          recordLoopStop(sessionId, "completed_unverified", { phase: "give-up", iteration: this.state.iteration });
          yield {
            type: "text_delta",
            text: "\n\n⚠️ 这一轮**没有跑过任何验证**就结束了 —— 上面的改动**未经证实**，请自行核对（跑一下测试或构建）。\n\n",
          };
        }

        /**
         * **第 108 波：红测试收尾守卫（"它看见了红还说完成"）。**
         *
         * 证据（真实评测里有一轮，装机版）：
         * agent 跑了某模块的三个判据文件，输出 **4 failed**
         * （其中就有最后让它没过的两条判据），
         * 它还专门 `git stash` 回基线复跑确认同样红 —— 然后只跑了另一组绿的（9 passed）
         * 就收工，回执写"已完成"。**红它看见了，还是把红说成了完成。**
         *
         * 上面那条"改了但没验证"守卫抓不到这种情况：它只看 `turnRanVerification`，
         * 而这里是**验证过了、结果是红的**。
         *
         * 处置：与既有守卫同一形状 —— **不硬停，只提醒一次**（红测试可能确实不该由它修，
         * 例如与本任务无关的既有缺陷）：要求"要么修掉、要么在回执里点名这条红"，然后继续。
         * 上限 1 次：第二次收尾就放行，绝不把模型困在这里。
         */
        /**
         * ⚠️ 通过一个**方法**读它，而不是直接读字段。
         *
         * 原因：本轮重置处写了 `this.lastTestRun = null`，TypeScript 的控制流分析于是
         * 认为"到收尾这里它一定是 null"，`redTest && redTest.failed` 会被收窄成 `never` 而报错。
         * 赋值真正的来源是 `noteTestRun()`（另一个方法），TS 看不进去 —— 走一层方法调用，
         * 既让类型恢复正确，也说清了"这个值随时可能被工具结果更新"。
         */
        const redTest: { command: string; failed: number; passed: number; redFiles: string[] } | null = this.currentTestRun();
        /**
         * **按文件**判红（不是只看最近一次运行）—— 理由见 `testFileStatus` 的字段注释：
         * 实测的失败形态正是"红过的那两个文件没再跑绿，但另一组文件跑绿了"。
         */
        const redFiles = this.currentRedTestFiles();
        if ((redFiles.length > 0 || (redTest && redTest.failed > 0)) && this.redTestNudges < RED_TEST_NUDGE_LIMIT) {
          this.redTestNudges++;
          /**
           * 报"几条失败"时要**取两者的大者**：`redTest.failed` 是最近一次运行的失败数，
           * 而最近一次可能是别组文件的绿运行（这时它是 0）—— 若直接用它，提醒里会出现
           * "0 条失败（还有文件是红的）"这种自相矛盾的话（判据 RT-5 第一次跑就是这么红的）。
           */
          const failedCount = Math.max(redFiles.length, redTest?.failed ?? 0);
          const fileList = redFiles.length > 0 ? `（${redFiles.join(", ")}）` : "";
          recordLoopStop(sessionId, "completed_unverified", { phase: "red-test-nudge", iteration: this.state.iteration });
          try {
            this.getMessageStorage().createMessage(
              {
                id: `red-test-nudge-${Date.now()}`,
                role: "user",
                content:
                  `[SYSTEM] 你这一轮跑过的测试里还有 **红的**：${failedCount} 条失败${fileList}` +
                  `${redTest ? `（最近一次命令：${redTest.command}）` : ""}。\n` +
                  "「跑另一组绿的」不能给这些文件洗白 —— 它们还是红的。现在你要收尾了，二选一：\n" +
                  "① 把**这些文件**跑到绿（正常收尾）；\n" +
                  "② 如果它们确实不该由你修（例如与本任务无关的既有缺陷），就在回执里**点名**：" +
                  "哪几条红、为什么留着、对用户意味着什么。\n" +
                  "不允许把这次收尾写成「已完成」而不提这些红。",
                timestamp: Date.now(),
                status: "done",
              },
              sessionId,
            );
            this.msgCache = null;
          } catch (e) {
            console.warn("[agentic-loop.ts]", e);
          }
          yield {
            type: "text_delta",
            text: `\n\n🧪 **测试还是红的**（${failedCount} 条失败${fileList}）：先处理它们，或在回执里说清为什么留着。\n\n`,
          };
          continue;
        }

        const result: LoopResult = {
          type: "stop",
          reason: "completed",
          usage: this.state.totalUsage,
        };
        // F1.3: Trigger memory extraction after turn completes
        if (this.config.memoryEnabled && this.config.onTurnComplete) {
          try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
        }
        yield { type: "end", result };
        return result;
      }

      if (this.state.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        const result: LoopResult = {
          type: "stop",
          reason: "too_many_errors",
          usage: this.state.totalUsage,
        };
        // F1.3: Trigger memory extraction even on error stop
        if (this.config.memoryEnabled && this.config.onTurnComplete) {
          try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
        }
        yield { type: "end", result };
        return result;
      }

      // New assistant message for next iteration is handled by App.tsx
      assistantMsgId = `msg-${Date.now() + this.state.iteration + 100}`;
    }

    // We only reach here if a safety valve triggered a break.
    // Determine the stop reason based on which safety valve fired.
    let stopReason = "safety_valve";
    let stopMessage = "";
    if (this.state.maxIterations > 0 && this.state.iteration >= this.state.maxIterations) {
      stopReason = "max_iterations";
      stopMessage = `\n\n⚠️ **已达到迭代上限 (${this.state.maxIterations})**，任务停止。如需继续，请重新发送指令。`;
    } else if (this.state.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
      stopReason = "no_progress";
      stopMessage = `\n\n⚠️ **检测到循环停滞**（连续 ${MAX_CONSECUTIVE_NO_PROGRESS} 次迭代无进展），任务已停止以防止死循环。`;
    }

    const result: LoopResult = {
      type: "stop",
      reason: stopReason,
      usage: this.state.totalUsage,
    };
    if (stopMessage) {
      yield { type: "text_delta", text: stopMessage };
    }
    // F1.3: Trigger memory extraction on max iterations stop
    if (this.config.memoryEnabled && this.config.onTurnComplete) {
      try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn('[agentic-loop.ts]', e) }
    }
    // P2-14: Record telemetry — turn end
    telemetry.record(sessionId, "turn_end", {
      duration_ms: Date.now() - turnStartTime,
      iterations: this.state.iteration,
      reason: stopReason,
      totalTokens: this.state.totalUsage?.totalTokens || 0,
    });
    // P1: Record trajectory — turn end (对标 DSH ui-trajectory)
    this.recordTrajectory(sessionId, "turn_end", {
      duration_ms: Date.now() - turnStartTime,
      iterations: this.state.iteration,
      reason: stopReason,
      totalTokens: this.state.totalUsage?.totalTokens || 0,
    }, Date.now() - turnStartTime);
    yield { type: "end", result };
    return result;
  }

  /**
   * F3.6: Generate a retrospective hint suggesting the user update AGENTS.md.
   * Only fires once per session to avoid nagging.
   */
  private getRetrospectiveHint(): string {
    if (this.retrospectiveSuggested || this.retrospectiveErrorCount < 2) return "";
    this.retrospectiveSuggested = true;
    return "\n\n💡 **回顾性建议**：检测到反复出错。考虑在项目的 `AGENTS.md` 中添加规则来避免此类问题，例如记录常见陷阱、正确的命令格式或编码规范。这有助于 AI 在未来的会话中避免同样的错误。";
  }

  /** Get a human-readable title for a tool call, used for step progress display */
  private getToolTitle(toolName: string): string {
    const titleMap: Record<string, string> = {
      read_file: "读取文件",
      write_file: "写入文件",
      edit_file: "修改文件",
      multi_edit_file: "批量修改文件",
      list_directory: "查看目录",
      search_code: "搜索代码",
      grep_search: "搜索代码",
      run_terminal_command: "执行命令",
      run_test: "运行测试",
      web_fetch: "获取网页",
      subagent: "委派子智能体", // 对标 DSH 工具名
      delegate_to_session: "委派会话",
      wait_for_delegation: "等待委派结果",
      query_session_result: "查询会话结果",
      list_sessions: "查看会话列表",
      cancel_delegation: "终止委派",
      create_file: "创建文件",
      delete_file: "删除文件",
      file_search: "搜索文件",
      todo_write: "更新任务",
      codebase_search: "搜索代码库",
      lsp: "代码导航",
      read: "读取文件",
      write: "写入文件",
      edit: "修改文件",
      multi_edit: "批量修改文件",
      glob: "查找文件",
      grep: "搜索内容",
      bash: "执行命令",
      tool_search: "加载工具",
      web_search: "网络搜索",
      install: "安装依赖",
      run: "运行程序",
      build: "构建项目",
      test: "运行测试",
    };
    return titleMap[toolName] || toolName;
  }

  /** 当前进行中步骤的标题（计划内取计划标题，计划外回退执行工具标题）。 */
  private currentStepTitle(): string {
    const plan = this.activePlan.plan;
    if (plan && plan[this.macroStep - 1]) {
      return plan[this.macroStep - 1].title;
    }
    return this.getToolTitle(this.lastExecToolName || "");
  }

  /**
   * update_plan 工具回调：把模型提交的插入操作应用到当前计划。
   * 成功返回 {ok:true, message}（message 含插入后完整计划，回给模型使其
   * 感知编号顺延）；失败返回 {ok:false, error}。
   */
  private applyPlanUpdate(op: PlanUpdateOp): { ok: true; message: string } | { ok: false; error: string } {
    const items = this.activePlan.plan ?? [];
    if (items.length === 0) {
      return { ok: false, error: "当前没有可更新的执行计划（仅对话任务进行中可用）。" };
    }
    const result = applyPlanUpdatePure(items, op, this.macroStep);
    if (!result.ok) return { ok: false, error: result.error };
    this.activePlan = { plan: result.items, total: result.items.length, fromLlm: this.activePlan.fromLlm };
    this.planDirty = true;
    // 第 65 波：真正的计划修订 —— 这是"任务层面往前走了一步"的可靠信号（停滞检测据此清零）
    this.planRevision++;
    console.log(
      `[AgenticLoop] Plan updated via update_plan (now ${result.items.length} steps):`,
      result.items.map((s) => s.title),
    );
    return { ok: true, message: result.message };
  }

  /**
   * 取"本轮助手消息在**消息存储**里的真实 id"（第 154 轮，O-28）。
   *
   * `fallback` 是引擎自造的 `msg-…`：只在落库方没接线 / 返回空串 / 抛错时使用
   * （子智能体与用例走的还是这条缺省路，行为与改前一致）。
   *
   * 为什么在**问的时候**才取、而不是在 run() 开头取一次：这个 id 由落库方在
   * "看到本轮 `start` 事件"时才生成（见 executor.ts / App.tsx），工具执行发生在
   * `start` 之后，所以此刻问到的就是本轮的真身。落库方若还没建行，
   * 它的回调会按需建行并返回 id（executor 的 `ensureAssistantMessage()`）。
   */
  private resolveMessageIdForTools(sessionId: string, fallback: string): string {
    const fn = this.config.resolveAssistantMessageId;
    if (!fn) return fallback;
    try {
      const id = fn(sessionId);
      return typeof id === "string" && id.length > 0 ? id : fallback;
    } catch (e) {
      /**
       * 落库方抛错**不许**拖垮回合：这里退回引擎自己的 id（回合照常跑完），
       * 但必须留痕 —— 静默退回正是"事件日志里的 id 又对不上"的复发形态。
       */
      console.warn("[AgenticLoop] resolveAssistantMessageId 回调抛错，本次退回引擎自造 id（事件里的 messageId 可能与消息行对不上）:", e);
      return fallback;
    }
  }

  private async *executeIteration(
    sessionId: string,
    assistantMsgId: string,
    apiMessages: any[],
    toolDefs: ToolDefinition[],
    cwd: string,
    systemPrompt: string,
    /**
     * 本轮追加到 system 消息尾部的**稳定**内容（deferred 工具提示 / 技能提示）。
     *
     * 为什么必须由调用方传进来、而不能像原来那样写 `apiMessages[0].content += …`：
     * `apiMessages[0]` 在真实会话里不是 system 消息 —— **system 消息是在本函数里
     * 单独构造的**（见下面 `request.messages[0]`），`messagesToLLMMessages` 还会
     * 明确丢掉 system 行。所以那个判据恒假，注入曾经是死代码。
     */
    extraSystemPrompt = "",
  ): AsyncGenerator<LoopEvent, void, unknown> {
    let currentText = "";
    let currentToolCalls: StreamingToolCall[] = [];
    let finishReason = "stop";
    let reasoningReceived = false;
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      // Vision Proxy: process image blocks before sending to LLM
      const visionProxy = this.getVisionProxy();
      const visionResult = await visionProxy.processMessages(
        apiMessages,
        this.config.model || this.provider.id,
        this.provider.id,
      );
      if (visionResult.visionUsed) {
        console.log(`[AgenticLoop] Vision proxy used: ${visionResult.visionModel} via ${visionResult.visionProvider}`);
        yield {
          type: "llm_status",
          status: "connecting",
        } as any;
      }
      const processedMessages = visionResult.messages;

      /**
       * 计划上下文**不再拼进 system 前缀**（第 ? 波：前缀缓存 / KV cache 稳定性）。
       *
       * 原实现是 `const baseSystemPrompt = systemPrompt + "\n\n" + planContext`，
       * 而 `planContext = renderPlanSection(this.activePlan.plan, this.macroStep)`
       * 在**同一轮**里就会变：
       * - `macroStep` 在 `run()` 消费本迭代事件时推进（tool_start 分支的
       *   `this.macroStep++`），于是第 N+1 次迭代渲染出的计划段与第 N 次不同；
       * - `this.activePlan.plan` 会被 `update_plan` 工具改写（插入/追加步骤）。
       *
       * 结果：`messages[0]` 在同一轮的第 1 次与第 2 次请求之间就变了 ⇒ provider 的
       * 前缀缓存（DeepSeek KV cache，命中价约为未命中的 1/4）整段失效 ——
       * 这正是 `dsh-d5-prefix-cache-stability.test.ts` 守的那条判据，只是它当时
       * 只覆盖了**跨轮**（时间戳），没覆盖**同轮跨迭代**。
       *
       * 现在计划段作为**独立的尾部 user 消息**注入（与 time-context / goals /
       * surface notice 同一形态，见 `run()` 里 `plan-context-*` 那段），
       * 每轮重新渲染 ⇒ 模型看到的信息只增不减，稳定前缀逐字节不变。
       */
      const effectiveSystemPrompt = extraSystemPrompt
        ? `${systemPrompt}\n${extraSystemPrompt}`
        : systemPrompt;

      const request: LLMRequest = {
        model: this.config.model || this.provider.id,
        messages: [
          { id: "system", role: "system", content: effectiveSystemPrompt },
          ...processedMessages,
        ],
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        temperature: this.config.temperature,
        stream: true,
        abortSignal: this.abortController!.signal,
        // E2: Pass reasoning effort to LLM
        reasoningEffort: this.config.reasoningEffort,
      };

      // R3-3.7: Request header tracking — use dedicated module for fingerprint + change detection
      const { trackRequestHeader, computeHeaderFingerprint } = await import("./request-header");
      const currentHeader = {
        model: request.model,
        systemPromptLength: systemPrompt.length,
        toolCount: toolDefs.length,
        temperature: request.temperature || 1.0,
        reasoningEffort: (request as any).reasoning_effort,
      };
      const headerChange = trackRequestHeader(sessionId, currentHeader);
      if (headerChange) {
        debugLog("agent-loop", `Request header changed: ${headerChange.reason} — prefix cache may miss`);
      }
      this.lastRequestHeader = computeHeaderFingerprint(currentHeader);

      // Stream events directly - no collection, real-time yielding
      let retryCount = 0;
      const maxRetries = 3;
      let success = false;

      while (!success && retryCount < maxRetries) {
        try {
          // Emit "connecting" state BEFORE calling provider.stream().
          // The fetch() happens inside provider.stream() on first iteration
          // of the async generator — this is where it can hang if the server
          // is unresponsive. The user sees "正在连接 AI 服务器..." and can
          // cancel via the ■ button at any time.
          debugLog("agent-loop", `Iteration ${this.state.iteration}: calling LLM (attempt ${retryCount + 1}/${maxRetries}), messages: ${apiMessages.length}, tools: ${toolDefs.length}`);
          /**
           * **第 132 波时延归因**：把"首字节等待（TTFT）"与"整段流式"分开记 ✓。
           *
           * 为什么要分开：246 的时延是对手的 1.47× ✗，而工具落库间隔≈0 ✓
           * ⇒ 要么是**应用在调模型前自己花的时间** ✗，要么是**模型本身**（首字节 / 解码）✗。
           * `llmReqT0 → 首事件` 是"连接 + 首字节（含 prompt 预填）"✓；
           * `首事件 → 流结束` 是"生成（含思考）"✓。两者对着看就知道该优化谁 ✓。
           */
          const llmReqT0 = Date.now();
          let llmFirstEventAt = 0;
          yield { type: "llm_status", status: "connecting" };
          let firstEventReceived = false;

          for await (const event of this.provider.stream(request)) {
            if (!firstEventReceived) {
              llmFirstEventAt = Date.now();
              firstEventReceived = true;
              // First byte received — connection is alive, now streaming
              yield { type: "llm_status", status: "streaming" };
            }
            switch (event.type) {
              case "text_delta":
                currentText += event.text;
                yield { type: "text_delta", text: event.text };
                break;

              case "reasoning_delta":
                reasoningReceived = true;
                yield { type: "reasoning_delta", text: event.text };
                break;

              case "tool_use_start":
                const tc: StreamingToolCall & { rawArgs?: string } = {
                  id: event.id,
                  name: event.name,
                  input: {},
                  status: "pending",
                  rawArgs: "",
                };
                currentToolCalls.push(tc);
                // Don't yield tool_start yet — wait for input to be parsed at tool_use_end
                break;

              case "tool_use_delta":
                const existing = currentToolCalls.find((t) => t.id === event.id);
                if (existing) {
                  (existing as any).rawArgs = ((existing as any).rawArgs || "") + event.input;
                }
                break;

              case "tool_use_end":
                const ended = currentToolCalls.find((t) => t.id === event.id);
                if (ended) {
                  // Prefer provider-parsed input if available
                  if (event.input && Object.keys(event.input).length > 0) {
                    ended.input = event.input;
                  } else if ((ended as any).rawArgs) {
                    // Fallback: parse from rawArgs accumulated via tool_use_delta
                    try {
                      ended.input = JSON.parse((ended as any).rawArgs);
                    } catch (parseErr: any) {
                      // 第 66 波：**删掉了"正则抽 path/content"的兜底**。
                      // 那段兜底在截断场景下会抽出 `content: ""`（因为结尾引号还没生成），
                      // 于是 write 会拿着空内容执行 —— 轻则写出空文件，重则把已有文件清空。
                      // 正确做法：把"参数不可用"这件事标出来，由后面的执行前检查拒绝执行并给出指引。
                      const raw = (ended as any).rawArgs as string;
                      (ended as any).argsError = parseErr?.message || String(parseErr);
                      (ended as any).argsRawLength = raw.length;
                      console.error(
                        `[AgenticLoop] Tool args are not valid JSON for ${ended.name} (${raw.length} chars) — 拒绝执行并引导分块:`,
                        (ended as any).argsError,
                        "…tail:",
                        raw.slice(-120),
                      );
                    }
                  } else if ((event as any).argsParseError) {
                    // 第 66 波（审计补）：provider 报了解析失败、而循环这边**没有 rawArgs 可重试**
                    // （例如 provider 只发了 tool_use_end）。此时绝不能带着空参数执行 ——
                    // 把这层错误原样接住，交给后面的"拒绝执行"分支。
                    (ended as any).argsError = (event as any).argsParseError;
                    (ended as any).argsRawLength = (event as any).rawLength ?? 0;
                  }
                  // Yield tool_start NOW with fully parsed input — preserves LLM output order
                  yield { type: "tool_start", toolCall: ended };
                }
                break;

              case "usage":
                if (event.usage) usage = event.usage;
                break;

              case "end":
                finishReason = event.finishReason;
                // 第 68 波：把本轮的结束原因写到循环状态里 —— 主循环的"要不要停"判断要用
                // （provider 的 end 事件不会向上游 yield，本地变量跨迭代拿不到）
                this.state.lastFinishReason = finishReason;
                // DSH-style EMPTY_RESPONSE: 模型以 stop 结束但没有任何输出
                // （无文本 / 无推理 / 无工具调用）是退化完成——静默结束 turn
                // 会让用户什么都看不到。抛出错误走既有重试路径，重试耗尽后
                // 结构化失败上报。绝不猜测用户意图或伪造 user 消息。
                if (
                  finishReason === "stop" &&
                  currentText.length === 0 &&
                  currentToolCalls.length === 0 &&
                  !reasoningReceived
                ) {
                  throw new Error("EMPTY_RESPONSE: model returned a completed response with no content");
                }
                break;

              case "heartbeat":
                // P-OPT3: SSE comment heartbeat — reset idle timer
                // DeepSeek sends `: keep-alive` during long reasoning.
                // This event keeps the stream alive without hard timeout kills.
                this.lastStreamActivity = Date.now();
                break;

              case "error":
                yield { type: "tool_error", toolCall: { id: "", name: "", input: {}, status: "error" }, error: event.error };
                break;
            }
          }
          /**
           * 一轮模型调用的时延拆分（第 132 波）：`TTFT`（连接+首字节/预填）与 `生成`（含思考）✓。
           * 只在 `codem-debug=agent-loop` 时输出 ✓。
           */
          debugLog(
            "agent-loop",
            `llm timing iter=${this.state.iteration}: TTFT=${llmFirstEventAt ? llmFirstEventAt - llmReqT0 : -1}ms`,
            `stream=${llmFirstEventAt ? Date.now() - llmFirstEventAt : -1}ms`,
            `total=${Date.now() - llmReqT0}ms`,
          );
          success = true;
          this.state.lastIterationTextChars = currentText.length;
          debugLog("agent-loop", `Iteration ${this.state.iteration}: LLM stream ended. finishReason: ${finishReason}, toolCalls: ${currentToolCalls.length}, text length: ${currentText.length}`);
          // 第 68 波：非正常结束原因要**默认可见**（debugLog 默认静默，出问题时控制台什么都没有）。
          // 用户报"任务又中断了"时，控制台里唯一线索就是 finish_reason —— 现在一眼能看出来。
          if (finishReason !== "stop" && finishReason !== "tool_use") {
            console.warn(
              `[AgenticLoop] 本轮结束原因 finish_reason=${finishReason}` +
                (finishReason === "length" ? "（达到单次输出上限，回复被截断）" : "") +
                ` — iteration ${this.state.iteration}, text ${currentText.length} chars, tool calls ${currentToolCalls.length}`,
            );
          }
        } catch (retryError: any) {
          retryCount++;
          console.error(`[AgenticLoop] Iteration ${this.state.iteration}: LLM stream error (attempt ${retryCount}/${maxRetries}):`, retryError.name, retryError.message);
          // 第 69 波：**不要对确定性错误白重试**。
          // 事故现场：上下文超限的 400 被重试 3 次（每次必然失败、还各带一次 1M token 请求），
          // 而真正该做的事（反应式压缩）压根没被触发。溢出错误直接抛给外层走压缩路径。
          if (isContextOverflowError(retryError.message)) {
            console.warn(`[AgenticLoop] 上下文溢出错误（不重试，交给压缩路径）: ${retryError.message?.slice(0, 160)}`);
            throw retryError;
          }
          const retryClass = classifyError(retryError);
          if (!retryClass.isRetryable) {
            console.warn(`[AgenticLoop] 不可重试的错误（4xx 客户端错误），立即失败: ${retryError.message?.slice(0, 160)}`);
            throw retryError;
          }
          if (retryCount >= maxRetries || retryError.name === "AbortError") {
            throw retryError;
          }
          // 对标 DSH resetForRetry：重试前清空已累积的文本/推理/工具调用状态。
          // 若不清理，第一轮失败前 yield 给前端的部分文本会残留在
          // streamBuffer（App.tsx 100ms 批量 flush），重试流的文本再 append
          // 到同一条消息 → 同迭代内整段重复（与首词重复同源的「多通道累积」）。
          currentText = "";
          reasoningReceived = false;
          currentToolCalls.length = 0;
          yield { type: "retry", attempt: retryCount, delay: 1000 * retryCount, error: retryError.message, errorType: retryError.name || null };
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
    } catch (error: any) {
      console.error(`[AgenticLoop] executeIteration error (iteration ${this.state.iteration}):`, error?.name, error?.message, error?.stack);
      if (error.name === "AbortError") {
        // Check if this abort was caused by immediate guidance injection
        if (this.guidanceInterrupt) {
          console.log(`[AgenticLoop] AbortError from guidance interrupt — will continue to next iteration`);
          this.guidanceInterrupt = false;
          return;
        }
        return;
      }

      // 第 69 波：溢出识别改成**语义匹配**（DeepSeek 的 wording 是 "maximum context length is ..."，
      // 旧的 `prompt_too_long` / `context_length_exceeded` 一个都不含 → 反应式压缩从未触发过）
      if (isContextOverflowError(error.message)) {
        // 已经压缩过太多次还放不下 → 明确告诉用户怎么办，别静默死掉
        if (this.state.consecutiveCompactions >= 3) {
          recordLoopStop(sessionId, "context_overflow", {
            consecutiveCompactions: this.state.consecutiveCompactions,
            message: error.message?.slice(0, 300),
          });
          yield { type: "text_delta", text: `\n\n${describeContextOverflow(error.message)}` };
          const overflowResult: LoopResult = { type: "stop", reason: "context_overflow", usage: this.state.totalUsage };
          if (this.config.memoryEnabled && this.config.onTurnComplete) {
            try { this.config.onTurnComplete(this.state.totalUsage); } catch (e) { console.warn("[agentic-loop.ts]", e) }
          }
          yield { type: "end", result: overflowResult };
          return;
        }
        if (this.config.enableReactiveCompaction) {
          yield { type: "compaction_start" };
          const compacted = await this.compactMessages(sessionId);
          yield { type: "compaction_end", messagesRemoved: compacted };
          // P2-C: Clear stale caches on reactive compaction too
          this.readCache?.clear();
          this.writeCache?.clear();
          this.msgCache = null;
          TranscriptCache.clear();

          this.state.microCompactedThisRun = false;
          // After compaction, the main loop will rebuild messages and retry.
          // We return from executeIteration so the main while loop continues.
          // Set a flag so the main loop knows we compacted and should retry.
          this.state.contextPressure = 0; // Reset pressure so it doesn't immediately re-trigger
          this.state.compactedThisIteration = true;
          this.state.consecutiveCompactions++;
          return;
        }
        /**
         * 第 86 波（静默终止）：反应式压缩被关掉时，上下文溢出原来直接 `return;` ——
         * 既没有文本、也没有事件，用户看到的是"助手突然不说话了"，也不知道原因。
         * 现在与"压缩次数用尽"走同一套可见路径：写一条说明 + 记录停止原因。
         */
        recordLoopStop(sessionId, "context_overflow", {
          reactiveCompactionDisabled: true,
          message: error.message?.slice(0, 300),
        });
        yield {
          type: "text_delta",
          text:
            `\n\n${describeContextOverflow(error.message)}` +
            `\n\n（本次**没有自动压缩**：设置里关闭了「反应式压缩」。请开启它，或新建对话后继续。）`,
        };
        yield {
          type: "end",
          result: { type: "stop", reason: "context_overflow", usage: this.state.totalUsage } as LoopResult,
        };
        return;
      }

      this.state.consecutiveErrors++;
      this.state.lastError = error.message;
      /**
       * 走到这里 = **最终失败**：内层 `while (!success && retryCount < maxRetries)`
       * 的重试已经在上面全部用掉（可重试错误会被内层 catch 拦住继续重试，
       * 根本走不到这里），或者这个错误压根不可重试（4xx）。
       * 因此这里是置位失败标志的**唯一正确位置** —— 「重试后成功」不会经过这里，
       * 也就不会被误报成失败。
       */
      this.state.lastIterationError = error.message;
      yield { type: "tool_error", toolCall: { id: "", name: "", input: {}, status: "error" }, error: error.message };
      // DSH-style: 结构化失败上报 — 失败必须对用户可见，绝不静默结束 turn。
      // 空 toolCall 的 tool_error 在 UI 上不可见（没有对应 tool call 可标记），
      // 因此同时输出文本，让用户看到发生了什么而不是"发消息不回复"。
      yield {
        type: "text_delta",
        text: `\n\n⚠️ **LLM 调用失败**（iteration ${this.state.iteration}）：${error.message}\n\n将自动重试，若连续失败会停止。如果长时间无响应，请检查 LLM 服务状态或点击 ■ 停止。`,
      };

      // R3-4.2: Generate postmortem report on critical errors
      try {
        const { generatePostmortem } = await import("./postmortem");
        await generatePostmortem(sessionId, error.message);
      } catch (pmErr) {
        // Non-critical — postmortem is best-effort
      }
      return;
    }

    // Text content is handled by App.tsx via text_delta events
    // No need to write to database here

    // ===== Single-response deduplication =====
    // DSH-style: 不再需要 spawn_subagent + wait_for_subagent 同轮次防护。
    // 新的 subagent 工具默认后台运行，不需要 wait_for。
    // 保留 delegate_to_session + wait_for_delegation 的同轮次防护。
    const seenReadPaths = new Set<string>();
    const seenWaitTaskIds = new Set<string>();
    const dedupedToolCalls: typeof currentToolCalls = [];
    const duplicateToolCalls: typeof currentToolCalls = [];

    // P5: Cross-session delegation two-step enforcement (subagent 已移除)
    const hasDelegateInResponse = currentToolCalls.some(tc => tc.name === "delegate_to_session");
    if (hasDelegateInResponse) {
      const delegationWaitCalls = currentToolCalls.filter(tc => tc.name === "wait_for_delegation");
      if (delegationWaitCalls.length > 0) {
        console.warn(`[AgenticLoop] P5: Rejected ${delegationWaitCalls.length} wait call(s) in same response as delegate — task IDs not available yet`);
        for (const wtc of delegationWaitCalls) {
          yield {
            type: "tool_error",
            toolCall: wtc,
            error: "Cannot wait_for_delegation in the same response as delegate_to_session — the task IDs are not available until the delegate results return. Send delegate_to_session calls first, then in your NEXT response use the returned task IDs to call wait_for_delegation.",
          };
        }
        currentToolCalls = currentToolCalls.filter(tc => tc.name !== "wait_for_delegation");
      }
    }

    // 第 62 波：这行日志原先只打印 task_id / path，于是 bash 一律显示成 `bash("")` ——
    // 用户贴日志排查"原地打转"时，恰恰是最需要看到命令的那一刻看不见命令。
    // 现在把 command 也带出来（截断），并把重复调用的次数一起打出来。
    const describeCall = (tc: StreamingToolCall) => {
      const input: any = tc.input ?? {};
      const arg = input.task_id ?? input.path ?? input.command ?? input.query ?? "";
      const text = typeof arg === "string" ? arg.replace(/\s+/g, " ").slice(0, 120) : JSON.stringify(arg ?? "");
      return `${tc.name}(${JSON.stringify(text)})`;
    };
    console.log(`[AgenticLoop] Single-response dedup: ${currentToolCalls.length} tool calls in this response: [${currentToolCalls.map(describeCall).join(", ")}]`);

    // ===== 第 66 波：参数不可用的调用**一律不执行** =====
    // 事故：模型一次 write 一个 6–10KB 脚本 → 参数 JSON 在输出上限处被截断 →
    // 旧逻辑降级成空参数继续执行（`write(content:"")`），模型还看不出原因、反复重试。
    // 这里改成：拒绝执行 + 给一句**可操作的**指引（分块写入），并落一条结构化事件便于统计。
    {
      const broken = currentToolCalls.filter((tc) => (tc as any).argsError);
      if (broken.length > 0) {
        for (const tc of broken) {
          const rawLen = (tc as any).argsRawLength ?? 0;
          console.error(`[AgenticLoop] Refusing to execute ${tc.name}: tool arguments were not valid JSON (${rawLen} chars)`);
          recordLoopStop(sessionId, "args_truncated", { tool: tc.name, rawLength: rawLen, error: (tc as any).argsError });
          yield {
            type: "tool_error",
            toolCall: tc,
            error: buildUnparsableArgsError(tc.name, rawLen, (tc as any).argsError, finishReason),
          };
        }
        currentToolCalls = currentToolCalls.filter((tc) => !(tc as any).argsError);
      }
    }

    // ===== 第 70 波（fail closed）：被输出上限截断的回复里，**一个工具调用都不执行** =====
    //
    // 第 67 波只做了「先执行、再提示核对完整性」，而注释自己就承认「我们不能证明它完整」。
    // 那条路是错的：流式参数由 provider 侧**尽力而为**地收尾，一个被切在半截的 `write`
    // 能解析、能校验、于是**照旧执行** —— 半个文件被写下去，还报告成成功。
    //
    // 现在的判据：这条回复是**被输出上限截断**的（`finish_reason=length`）⇒
    // 其中任何一个工具调用的参数都**无法证明完整**，所以整批拒绝执行
    // （对标 Pi Agent Harness `failToolCallsFromTruncatedMessage`），
    // 每个调用各报一条**结构化失败**（`isError: true` 由执行器的错误路径统一落）+
    // 一句可操作的指引（分块写入 / 拆小 / 原样重发会被守卫拦下）。
    //
    // 为什么整批而不是只拦内容型工具：只有**最后一个**调用能被证明是"被切的那个"，
    // 其余调用同样无法证明完整；而 `bash` 的命令被切断同样危险
    // （`rm -rf /some/dir` 截成 `rm -rf /`），只读工具用残缺路径也会读到错东西。
    // 代价是多花一轮让模型重发整批调用 —— 与"静默写下半截文件"相比这个代价是划算的。
    //
    // 与「第 66 波」（参数 JSON 解析失败）**互补**：那里连 JSON 都不是，
    // 这里 JSON 合法但无法证明完整。两条路都拒绝执行，文案不同。
    if (finishReason === "length") {
      const refusedCalls = currentToolCalls;
      if (refusedCalls.length > 0) {
        console.warn(
          `[AgenticLoop] Response hit the output limit (finish_reason=length) — refusing to execute ` +
            `${refusedCalls.length} tool call(s) whose arguments cannot be proven complete`,
        );
        recordLoopStop(sessionId, "output_truncated", {
          phase: "refused-tool-calls",
          toolCalls: refusedCalls.length,
          contentBearingCalls: refusedCalls.filter((tc) => isContentBearingTool(tc.name)).length,
        });
        for (const tc of refusedCalls) {
          const message = buildTruncatedToolCallError(tc.name);
          /**
           * 失败要**显式声明**，不能只靠文本（这是第 84 波以来的仓库契约：
           * 「把失败写在 output 里」不等于成功）。`isError` 是给分类器/上层的机器可读标记，
           * `status: "error"` 让调用对象自己就带着失败状态（而不是等 UI 去猜）。
           */
          tc.status = "error";
          tc.error = message;
          (tc as { isError?: boolean }).isError = true;
          yield {
            type: "tool_error",
            toolCall: tc,
            error: message,
          };
        }
        currentToolCalls = [];
      }
    }
    for (const tc of currentToolCalls) {
      const isRead = tc.name === "read" || tc.name === "read_file";
      const filePath = tc.input?.path || tc.input?.file_path;
      if (isRead && filePath && typeof filePath === "string") {
        // 去重键必须包含 offset/limit：同 path 不同 range 是两次不同读取
        // （与 readCache 的 offset/limit 区分一致），否则模型先读全文再读
        // 特定片段时第二个 read 会被误判为重复而跳过。
        const readOffset = typeof tc.input?.offset === "number" ? tc.input.offset : 1;
        const readLimit = typeof tc.input?.limit === "number" ? tc.input.limit : 2000;
        /**
         * 第 116 波：**行号开关也必须进去重键**。
         *
         * 与读缓存是同一个坑的两处（那处已在 `readCache` 修掉，行为判据 RT-12）：
         * 同一个响应里先 `read(path)`、再 `read(path, { line_numbers: true })`，
         * 若键里只有 path/offset/limit，第二次会被判成"同一响应里的重复调用"而**跳过** ——
         * 模型要的带行号版本永远拿不到，而它会以为自己已经看过了。
         */
        const readNumbering = tc.input?.line_numbers === true ? "n" : "p";
        const readKey = `${filePath}|${readOffset}|${readLimit}|${readNumbering}`;
        if (seenReadPaths.has(readKey)) {
          duplicateToolCalls.push(tc);
          continue;
        }
        seenReadPaths.add(readKey);
      }
      // Deduplicate wait_for_delegation with the same task_id (wait_for_subagent 已移除)
      if (tc.name === "wait_for_delegation") {
        const taskId = tc.input?.task_id as string;
        // Within-response dedup: same task_id called multiple times in one response
        if (taskId && seenWaitTaskIds.has(taskId)) {
          duplicateToolCalls.push(tc);
          continue;
        }
        // Cross-iteration dedup: task_id already collected in a previous iteration.
        const cache = this.waitedDelegations;
        if (taskId && cache.has(taskId)) {
          console.warn(`[AgenticLoop] Single-response dedup: ${tc.name}(${taskId}) already collected in previous iteration — skipping`);
          duplicateToolCalls.push(tc);
          continue;
        }
        if (taskId) seenWaitTaskIds.add(taskId);
      }
      dedupedToolCalls.push(tc);
    }
    if (duplicateToolCalls.length > 0) {
      console.warn(`[AgenticLoop] Removed ${duplicateToolCalls.length} duplicate tool calls in same response`);
      for (const dtc of duplicateToolCalls) {
        const isCrossIterWait = dtc.name === "wait_for_delegation" && // wait_for_subagent 已移除
          (this.waitedSubagents.has(dtc.input?.task_id as string) || this.waitedDelegations.has(dtc.input?.task_id as string));
        yield {
          type: "tool_error",
          toolCall: dtc,
          error: isCrossIterWait
            ? `Skipped: ${dtc.name} for this task was already called in a previous iteration. The result was already collected. Do NOT call ${dtc.name} for this task again. Proceed to the next step (e.g., write the output file).`
            : "Skipped: Duplicate tool call in one response. This was automatically filtered out to prevent redundant operations.",
        };
      }
      currentToolCalls = dedupedToolCalls;
    }

    // Update usage
      this.state.totalUsage.promptTokens += usage.promptTokens;
      this.state.totalUsage.completionTokens += usage.completionTokens;
      this.state.totalUsage.totalTokens = this.state.totalUsage.promptTokens + this.state.totalUsage.completionTokens;
      if (usage.cacheHitTokens !== undefined) {
        this.state.totalUsage.cacheHitTokens = (this.state.totalUsage.cacheHitTokens ?? 0) + usage.cacheHitTokens;
      }
      this.state.totalUsage.uncachedInputTokens = Math.max(
        0,
        this.state.totalUsage.promptTokens - (this.state.totalUsage.cacheHitTokens ?? 0),
      );
      // 每轮成本：按 provider 实际上报 cache 口径计价（uncached×输入价 + cache×缓存价）
      if (this.config.costTracker) {
        const modelId = this.config.model || this.provider.id;
        const callCost = (this.config.costTracker as any).calculateCost?.(modelId, usage) ?? 0;
        this.state.totalUsage.cost = (this.state.totalUsage.cost ?? 0) + callCost;
      }
      // R3-1.6: Record actual usage in TokenTracker for pressure estimation
      const tracker = getTokenTracker();
      const toolDefTokens = estimateToolDefinitionTokens(toolDefs);
      tracker.recordActualUsage(usage, toolDefTokens, this.lastRequestHeader || "");
      // P2-14: Record telemetry — LLM response with token usage
    this.getTelemetry().record(sessionId, "llm_response", {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      model: this.provider.id,
      iteration: this.state.iteration,
    });
    // P1: Record trajectory — LLM call (对标 DSH ui-trajectory，含 provider/model/usage 细节)
    this.recordTrajectory(sessionId, "llm_call", {
      provider: this.provider.id,
      model: this.config.model || this.provider.id,
      iteration: this.state.iteration,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cacheHitTokens: usage.cacheHitTokens,
        uncachedInputTokens: usage.uncachedInputTokens,
      },
      toolCallCount: currentToolCalls.length,
    }, Date.now() - (this.state.turnStartTime ?? Date.now()));
    // P1: Record trajectory — assistant output (text content)
    if (currentText.trim()) {
      this.recordTrajectory(sessionId, "assistant_output", { content: currentText.substring(0, 500), iteration: this.state.iteration });
    }
    yield { type: "usage", usage };

    // If no tool calls, we're done
    if (currentToolCalls.length === 0) {
      return;
    }

    // Limit destructive tools (write/edit/multi_edit) to 1 per iteration
    // This prevents the LLM from generating multiple conflicting writes that cause content corruption
    const destructiveTools = currentToolCalls.filter(tc =>
      tc.name === "write" || tc.name === "edit" || tc.name === "multi_edit"
    );
    const filteredToolCalls: StreamingToolCall[] = [];
    if (destructiveTools.length > 1) {
      console.warn(`[AgenticLoop] LLM generated ${destructiveTools.length} destructive tool calls in one iteration, keeping only the first`);
      // Keep only the first destructive tool call, collect the rest for error reporting
      let firstSeen = false;
      currentToolCalls = currentToolCalls.filter(tc => {
        const isDestructive = tc.name === "write" || tc.name === "edit" || tc.name === "multi_edit";
        if (!isDestructive) return true;
        if (!firstSeen) { firstSeen = true; return true; }
        // Track filtered-out tool calls so we can emit error events for them
        filteredToolCalls.push(tc);
        return false;
      });
    }

    // S4: Emit tool_error events for filtered-out destructive tool calls
    // This ensures the UI marks them as "skipped" instead of showing "running" forever
    for (const ftc of filteredToolCalls) {
      yield {
        type: "tool_error",
        toolCall: ftc,
        error: "Skipped: Only one write/edit/multi_edit call is allowed per response. This duplicate was automatically filtered out.",
      };
    }

    // Execute tools
    this.state.toolCallsInIteration = currentToolCalls.length;
    // Track how many tool calls were cache hits (no new work done).
    // If ALL tool calls in this iteration were cache hits, we treat it as
    // a no-op iteration so the loop can check stop conditions and exit.
    let cacheHitCount = 0;
          // Notify UI that we've transitioned from LLM streaming to tool execution
      yield { type: "llm_status", status: "executing_tools" };
      /**
       * ⚠️ 第 154 轮（O-28）：这里的 `messageId` **必须是消息存储里那一行的真实 id**。
       *
       * 它会被 `EventLogFinalizeMiddleware` 写进 `tool_call` / `tool_result` 事件的载荷，
       * 而消费方（`runtime-invariants` 的"可见即已记录"、`event-projection.applyToolCall`）
       * 都拿它去 `messages` 表里找那一行。用引擎自造的 `msg-…` 会**找不到**
       * ⇒ 维护自检报缺口、投影重建凭空多出一条 `msg-…` 助手行。
       * 真机取证与完整推理写在 `AgenticLoopConfig.resolveAssistantMessageId` 的注释里。
       */
      const toolMessageId = this.resolveMessageIdForTools(sessionId, assistantMsgId);
      const toolCtx: ToolContext = {
        sessionId,
        messageId: toolMessageId,
        cwd,
        // P1-6: Don't use ctx.abort — let each tool have its own abortController
        abort: undefined as any,
        // NOTE: Do NOT call buildMessages() here — it would pollute the cache
        // with a fingerprint where tool calls are still "running" (no results yet).
        // The next iteration's buildMessages would then get a cache hit and return
        // stale messages WITHOUT tool results, causing the LLM to retry tool calls.
        // No tool currently reads ctx.messages, so passing empty is safe.
        messages: [],
        metadata: () => {},
        // S4: Pass write confirmation callback for diff review
        onWriteConfirm: this.config.onWriteConfirm,
        // Security mode: controls whether write confirmation and permission checks are active
        securityMode: this.config.securityMode || "ask",
        // Phase D: Interactive form & prompt optimization callbacks
        getSystemPrompt: this.config.getSystemPrompt,
        onPromptChangeSubmit: this.config.onPromptChangeSubmit,
        onInteractiveForm: this.config.onInteractiveForm,
                // Phase F: Notebook knowledge mode
        notebookId: this.config.notebookId,
        // 步骤计划：update_plan 工具回调 → 动态插入/追加语义步骤
        updatePlan: (op) => this.applyPlanUpdate(op),
      };

    for await (const event of this.executor.execute(
      currentToolCalls,
      toolCtx,
      async (name, args, ctx) => {
        const tool = this.tools.get(name);
        if (!tool) {
          return { id: "", name, input: args, output: `Tool "${name}" not found`, status: "error" as const };
        }

        // S0-1: Plan mode and Permission checks are now handled by the ToolPipeline
        // (PlanModeGuard in guard layer, PermissionMiddleware in pre-execute layer).
        // Do NOT duplicate them here — the pipeline calls this function as the
        // execute-layer handler after guards have already passed.

        // ===== 第 62 波：重复调用守卫 =====
        // 放在快照/权限之前：被拦下的调用不应该产生任何副作用（快照、权限询问都不该发生）。
        // 事故背景见 loop-guard.ts 顶部 —— 交接后的会话原地枚举几十次，跑到父会话等待超时。
        const guardDecision = this.repeatGuard.inspect(name, args as Record<string, unknown>, { cwd: ctx.cwd });
        if (guardDecision.action === "suppress" || guardDecision.action === "stop") {
          this.guardSuppressedThisIteration++;
          console.warn(
            `[AgenticLoop] Repeat guard ${guardDecision.action}: ${name} (${guardDecision.kind}, x${guardDecision.count}) — ${guardDecision.signature ?? ""}`,
          );
          if (guardDecision.action === "stop" && !this.guardStopMessage) {
            this.guardStopMessage = guardDecision.message ?? "检测到重复操作，已停止。";
            this.guardStopKind = guardDecision.kind ?? "no-gain";
          }
          // 审计修正：这里必须是 "completed" 而不是 "error"。
          // executor 会把 status:"error" 的结果当成 tool_error 抛出，而 tool_error 会累加
          // consecutiveErrors —— 上限只有 3，于是「第 7 次抑制」根本走不到，
          // 循环会先以「连续错误过多」停掉，理由是错的（用户看到"错误"而不是"你在原地打转"）。
          return {
            id: "",
            name,
            input: args,
            output: guardDecision.message ?? "Skipped: repeated identical tool call.",
            status: "completed" as const,
            // 第 97 波：循环合成的结果 ⇒ 不参与工具的输出契约校验（见 types.ts 的 errorSource 说明）
            errorSource: "loop" as const,
          };
        }

        // Auto-snapshot before destructive tools
        //
        // 判据来自契约（`needsPreCallSnapshot` = 改工作区 或 破坏性），不再按名字列举。
        // 旧写法 `["write","edit","bash"]` 漏了 `multi_edit`（它同样能改文件），
        // 于是同类工具漏登记就静默失去快照保护。
        const callContract = this.tools.getContract(name);
        if (needsPreCallSnapshot(callContract) && ctx.cwd) {
          await this.ensureSnapshot(ctx.cwd, ctx.sessionId);
          // 逐文件快照只对「按 path 改单个文件」的工具做（write/edit 系列）
          if (
            mutatesWorkspace(callContract) &&
            typeof args.path === "string" &&
            this.currentSnapshotId
          ) {
            try {
              const { readFile } = await import("../file-api");
                const snapshotService = this.getSnapshotService(ctx.cwd);
              let content = "";
              let isNew = false;
              try {
                content = await readFile(args.path);
              } catch {
                // File doesn't exist yet (new file) — mark as new
                isNew = true;
              }
              await snapshotService.recordFile(this.currentSnapshotId, args.path, content, isNew);
            } catch (e) { console.warn('[agentic-loop.ts]', e) }
          }
        }

        // ===== State-based deduplication =====
        // Instead of counting loops and breaking, we intercept redundant operations
        // and return cached results with clear guidance to the LLM.
        const filePath = typeof args.path === "string" ? args.path : "";

        // READ: if this file was already read in this request and hasn't been written since,
        // return cached content instead of re-reading
        const readOffset = typeof args.offset === "number" ? args.offset : 1;
        const readLimit = typeof args.limit === "number" ? args.limit : 2000;
        /** 第 114 波：本次读取是否要行号（它**必须**进缓存键，见下面的注释） */
        const readLineNumbers = args.line_numbers === true;
        if ((name === "read" || name === "read_file") && filePath && this.readCache.has(filePath)) {
          const cached = this.readCache.get(filePath)!;
          /**
           * 第 114 波：**行号开关也必须进缓存键**。
           *
           * 缓存里存的是**渲染后的文本**（`result.output`）。若只比 path/offset/limit，
           * 那么「先带 `line_numbers: true` 读一段、再不带开关读同一段」会命中缓存，
           * 把**带行号的旧文本**当成这次的结果返回（反过来也一样）——
           * 内容没错，但**模型拿到的形状不是它要的**，而且是静默发生的（这类"缓存把形状搞混"
           * 是最难查的一种：模型看到的东西与它请求的不一致）。
           */
          if (cached.offset === readOffset && cached.limit === readLimit && cached.lineNumbers === readLineNumbers) {
            console.log(`[AgenticLoop] Cache hit for read ${filePath} (offset=${readOffset}, limit=${readLimit}) — returning cached content`);
            cacheHitCount++;
            return {
              id: "",
              name,
              input: args,
              output: `[CACHE HIT] This file was already read earlier in this conversation. The content has not changed since then. Use the content below directly — do NOT call read again.\n\nFile: ${filePath}\n\n${cached.output}`,
              status: "completed" as const,
              // 第 97 波：循环合成的结果 ⇒ 不参与输出契约校验（真机上它把每次缓存命中变成契约错误）
              errorSource: "loop" as const,
            };
          }
          // Range mismatch — fall through to a real read instead of returning stale content
          console.log(`[AgenticLoop] Read cache mismatch for ${filePath} (cached offset=${cached.offset}/limit=${cached.limit}, requested offset=${readOffset}/limit=${readLimit}) — re-reading`);
        }

        // WRITE: if this file was already written with EXACTLY the same content in this request,
        // skip the write and tell the LLM
        if ((name === "write") && filePath && this.writeCache.has(filePath)) {
          const lastWritten = this.writeCache.get(filePath)!;
          const newContent = typeof args.content === "string" ? args.content : "";
          if (lastWritten === newContent) {
            console.log(`[AgenticLoop] Skipping duplicate write to ${filePath} — identical content`);
            cacheHitCount++;
            return {
              id: "",
              name,
              input: args,
              output: `[NO-OP] This exact content was already written to ${filePath} earlier in this conversation. The file already contains this content. Do NOT write again. Report success to the user and stop.`,
              status: "completed" as const,
              // 第 97 波：循环合成的结果 ⇒ 不参与输出契约校验
              errorSource: "loop" as const,
            };
          }
        }

        // WAIT_FOR_DELEGATION: if this task was already waited on in a previous iteration,
        // return the cached result and tell the LLM to stop calling wait for it.
        // (wait_for_subagent 已移除)
        if (name === "wait_for_delegation") {
          const taskId = typeof args.task_id === "string" ? args.task_id : "";
          console.log(`[AgenticLoop] ${name} called: task_id="${taskId}", args=${JSON.stringify(args).substring(0, 200)}`);
          if (!taskId) {
            console.warn(`[AgenticLoop] ${name} called WITHOUT task_id! Full args:`, JSON.stringify(args));
          }
          const cache = this.waitedDelegations;
          if (taskId && cache.has(taskId)) {
            const cachedResult = cache.get(taskId)!;
            console.warn(`[AgenticLoop] ${name}(${taskId}) CACHE HIT — already collected in a previous iteration`);
            cacheHitCount++;
            return {
              id: "",
              name,
              input: args,
              output: `[ALREADY COLLECTED] You already called ${name} for task ${taskId} in a previous iteration and received the result. Do NOT call ${name} for this task again. Use the result you already received. Here is the cached result for reference:\n\n${cachedResult}\n\nIf you have collected all results, proceed to the next step (e.g., write the output file). Do NOT wait again.`,
              status: "completed" as const,
              // 第 97 波：循环合成的结果 ⇒ 不参与输出契约校验
              errorSource: "loop" as const,
            };
          }

          // 第 64 波：等待改成"按活动返回"之后，仍有"秒回式空转"的可能（子会话安静时每次查看都秒回）。
          // 判据同样用**信息增益**而不是次数：比较两次查看之间子会话的进度是否变化 ——
          // 进度没变（没有新工具调用、没有新事件）说明它确实没动静，这时才劝退。
          if (taskId) {
            const prog = getDelegationOrchestrator().getTask(taskId)?.progress;
            const progressKey = `${prog?.toolCalls ?? 0}|${prog?.updatedAt ?? 0}|${prog?.lastTool ?? ""}`;
            const prevKey = this.delegationProgressAtWait.get(taskId);
            const stuck = prevKey !== undefined && prevKey === progressKey
              ? (this.delegationStuckPeeks.get(taskId) ?? 0) + 1
              : 0;
            this.delegationStuckPeeks.set(taskId, stuck);
            this.delegationProgressAtWait.set(taskId, progressKey);
            if (stuck >= 2) {
              console.warn(`[AgenticLoop] ${name}(${taskId}) 两次查看之间没有任何进展 —— 抑制，引导不再空转`);
              this.guardSuppressedThisIteration++;
              return {
                id: "",
                name,
                input: args,
                output:
                  `[REPEAT GUARD] 你两次查看这个委派任务之间，它**没有任何新的进展**（工具调用次数/最近动作都没变）。\n` +
                  `**不要再查看或等待了。** 请二选一：\n` +
                  `  ① 向用户报告「子会话已安静、卡在什么动作上」（用上一次返回的进度信息）；\n` +
                  `  ② 用 cancel_delegation 终止它，然后基于已有部分产出自行动手收尾。`,
                status: "completed" as const,
              };
            }
          }
        }

        // S0-2: PreToolUse hooks are now handled by HookPreExecuteMiddleware
        // in the pipeline's pre-execute layer. Do NOT duplicate them here.
        const effectiveArgs = args;

        // 第 67 波当年的形态是"先执行、再在结果末尾提示核对完整性"。
        // 第 70 波改成 **fail closed**（见上面 `finishReason === "length"` 的整批拒绝）：
        // 截断回复里的调用**根本不会执行**，所以这里不再需要"事后核对"——
        // 真正需要核对的东西已经不存在了。内容型工具的分块写入指引移到了
        // `buildTruncatedToolCallError`（`tool-args-guard.ts`），并随拒绝一起给模型。
        //
        // 下面的判断是**纵深防御**：正常情况下不可达（上面已经整批拒绝并清空
        // currentToolCalls）。但万一将来有人绕过那条拒绝，内容型工具也绝不许拿到
        // 可能被切半截的参数去写盘 —— 在**执行之前**直接抛错（不是执行之后补救）。
        if (finishReason === "length" && isContentBearingTool(name)) {
          throw new Error(
            `refusing to execute content-bearing tool ${name}: the response was truncated by the output limit`,
          );
        }

        const result = await tool.execute(effectiveArgs, ctx);

        // 第 65 波：交付物计数 —— 只有"写下来了"才算推进（读多少都不算）。
        // 第 83 波修正：判定改成**分级证据**（见 artifact-tracker.ts）——
        // "可能写"的命令（python/node/npm/git…）在**同一条反复出现**时不再算推进，
        // 否则"用脚本当读手段"的会话会让停滞守卫永远清零（真机现场：四道阀门同时失效）。
        let artifactThisCall = false;
        {
          const cmd = String((effectiveArgs as any)?.command ?? (effectiveArgs as any)?.cmd ?? "");
          const isBashLike = name === "bash" || name === "shell" || name === "run_command" || name === "terminal";
          // 【本轮新增】把「验证过了」单独记下来 —— 光"写了"不算完成（见字段声明处的说明）。
          if (isBashLike && looksLikeVerificationCommand(cmd)) this.turnRanVerification = true;
          const verdict = this.artifactTracker.note(
            name,
            effectiveArgs as Record<string, any>,
            result.output,
            isBashLike ? bashIntent(cmd) : null,
          );
          if (verdict.artifact) {
            this.iterationProducedArtifact = true;
            artifactThisCall = true;
          } else if (verdict.verdict === "speculative-repeat") {
            console.log(
              `[AgenticLoop] 交付物判定：同一条"可能写"的命令已重复 ${this.artifactTracker.speculativeCountOf(cmd)} 次且期间没有任何可证明的写操作 → 本轮不计推进（${name}: ${cmd.slice(0, 80)}）`,
            );
          }
        }
        if (artifactThisCall) {
          this.turnModifiedFiles = true;
          /**
           * 第 140 波：**改动发生在什么时候**才是判据 ✓ ——
           * 跑过验证之后又改文件 ⇒ 那次验证不再作数 ✗。
           */
          this.turnEditsAfterVerification = true;
        }
        /**
         * ⚠️ **第 140 波：清零必须放在 `artifactThisCall` 之后** ✓ ——
         *
         * `artifactTracker` 会把"**可能写**"的命令（含 `npx vitest …` 这类带输出重定向可能的）
         * 也判成 artifact ✗ ⇒ 如果清零放在它**前面**，一条验证命令会先清零、再被自己置回 true ✗
         * ⇒ 收尾守卫**每次收尾都多问一轮** ✗（实测：4 条既有收尾判据当场变红 ✓，
         * 其中 RT-2 的对照用例报 `expected 3 to be 2` ✓）。
         *
         * 时序上正确的语义是：这一调用**是验证** ⇒ 它之后的盘上状态是"已验证" ✓。
         */
        {
          const cmdAfter = String((effectiveArgs as any)?.command ?? (effectiveArgs as any)?.cmd ?? "");
          const isBashAfter = name === "bash" || name === "shell" || name === "run_command" || name === "terminal";
          if (isBashAfter && looksLikeVerificationCommand(cmdAfter)) this.turnEditsAfterVerification = false;
        }

        // 第 64 波：把**结果**交给守卫 —— 判"原地打转"的依据是"拿到的东西是不是已经有了"，
        // 不是"调用了几次"。守卫据此累计"零信息增益"次数，下一次 inspect 时决定提醒/跳过/停。
        let guardGain: { gained: boolean; streak: number } | undefined;
        try {
          guardGain = this.repeatGuard.noteResult(name, effectiveArgs, result.output);
        } catch (e) { warnOnce("repeat-guard:note-result", "[agentic-loop] 记录守卫结果失败", e); }

        /**
         * 第 108 波：顺手记住"这次是不是在跑测试、红了几条"（供收尾守卫用）。
         *
         * 放在这里的原因与 `noteResult` 一样：**这是唯一同时拿得到命令与输出**的地方，
         * 而"测试是否还红着"必须由实际输出判定，不能靠猜。
         */
        try {
          this.noteTestRun(name, effectiveArgs, String(result.output ?? ""));
        } catch (e) { warnOnce("red-test-guard:note", "[agentic-loop] 记录测试结果失败", e); }

        // 第 93 波治本：把「这次拿到的是不是新信息」接进停滞判定。
        // 为什么放在这里：noteResult 是**唯一**有「结果内容是不是新的」证据的地方，
        // 而停滞守卫原来只看「有没有写盘」，于是在大仓库里逐文件读的探索被判成零进展。
        // 注意只认 gained === true：宽容/骗过的路径（写后重看、幂等写）在 noteResult 内部
        // 已经有独立记账，这里不重复解释。
        if (guardGain?.gained) this.iterationGainedInformation = true;

        // 守卫的「提醒」档 —— 边执行边把提示贴到结果末尾（不打断，只纠正方向）
        if (guardDecision.action === "warn" && guardDecision.message) {
          result.output = `${result.output ?? ""}\n\n${guardDecision.message}`;
        } else if (guardGain && !guardGain.gained) {
          result.output =
            `${result.output ?? ""}\n\n[REPEAT GUARD] 这次拿到的内容与之前**完全相同**（连续第 ${guardGain.streak} 次零信息增益）。` +
            `再重复同类调用不会产生新信息：请换手段，或直接基于已有信息推进/报告。`;
        }

        /**
         * **测试红了 ⇒ 把"红的是哪个判据文件"直接递到它眼前**（第 111 波）。
         *
         * 证据（第 110 波实测四个失败任务**全零**）：agent 会跑红的那条判据，却**从不读它** ——
         * 读的都是它自己觉得相关的其它判据。于是它不知道期望的语义，只能照症状猜着改
         * （只补了报错路径的一条分支、规格里要求的几种状态没做全）。
         *
         * 为什么做成"附在结果里"而不是另发一条消息：**时机**。模型此刻正盯着这段失败输出，
         * 指针就在同一段文本里，不需要额外一轮去理解；也不额外消耗一次 LLM 调用。
         * （与 `[REPEAT GUARD]` 同一手法：就地纠正方向，不打断。）
         */
        if (this.lastTestRun && this.lastTestRun.failed > 0 && (this.lastTestRun.redFiles?.length ?? 0) > 0) {
          const red = this.lastTestRun.redFiles.slice(0, 5).join(", ");
          result.output =
            `${result.output ?? ""}\n\n[RED TEST] 这次红的是：${red}。` +
            `**先去读这些判据文件** —— 它们写明了期望的语义（失败消息、三态、边界条件都在里面）；` +
            `照着症状猜通常只修到其中一条分支。`;

          /**
           * 第 109 波：**红了之后再放一次「这一族判据」**。
           *
           * 证据：237 的 repo-02 —— run-2 用了清单（碰了 dsh-d9）⇒ 通过 ✓；
           * run-3 没用 ⇒ 失败 ✗。同一份清单、同一个构建，差别是**注意力**：
           * 完整清单只在会话第一条消息尾部投递一次，到这一刻已被 20+ 次工具调用推远 ✗。
           * 所以在此刻（它正盯着失败输出）再放一次紧凑版；每回合只放一次 ✓。
           */
          if (!this.familyReminderSentInTurn) {
            this.familyReminderSentInTurn = true;
            try {
              const reminder = await buildFamilyReminder(this.lastCwd || process.cwd(), this.lastUserMessage);
              /**
               * **第 119 波：与关键词清单同一套可见性** —— 成功与 `null` 都记一行 ✓。
               *
               * 为什么需要：117 波证明"关键词清单"真的到了模型 ✓，
               * 但**第二个机制（红了之后再放一次族提醒）没有任何直接证据来源** ✗ ——
               * 它只在"测试跑出红"时才可能触发 ✗，而"事件里搜不到"根本不能用来判定 ✗
               * （注入内容不进 `session_events` ✗）。所以这里补一行 debugLog ✓，
               * 让下一次真机排查可以直接读出"有没有触发/是不是 null" ✓。
               */
              debugLog(
                "agent-loop",
                "family reminder:",
                reminder ? `${reminder.length} chars` : "null",
                "| cwd=",
                this.lastCwd || process.cwd(),
                "| msgLen=",
                this.lastUserMessage?.length ?? 0,
              );
              if (reminder) result.output = `${result.output}\n\n${reminder}`;
            } catch (reminderErr) {
              console.warn("[AgenticLoop] family reminder failed:", reminderErr);
            }
          }
        }

        /**
         * **第 125 波：编辑之后，把「还有哪些判据文件提到你刚改的符号」以事实列出** ✓。
         *
         * 依据（§13.47）：对照臂赢的那次用的原语就是"一次按**符号**的 grep ⇒
         * 匹配清单里同时出现源码与测试文件" ✓；而"把判据名送到眼前"那四个机制对 repo-02 全无效 ✗
         * （任务的中文描述词在仓库里**根本不存在** ✗）。
         * 这一条与它们不同：由**它自己的编辑动作**触发 ✓、内容与它刚做的事**直接相关** ✓，
         * 而且只列事实（不说"你应该跑""你漏了" ✗）。
         *
         * ⚠️ 它必须在本层（而不是上面那个 RED TEST 的 `if` 里面 ✓）：触发条件是**编辑** ✓，
         * 与"有没有红"无关 ✗ —— 第一版我插在 RED TEST 块内 ✗，于是"没跑测试就编辑"时永远不触发 ✗
         * （接线判据 SSB-W1 当场抓住 ✓）。
         *
         * 每回合最多一次 ✓；失败静默 ✓（非关键路径 ✓）。
         */
        if (this.symbolSiblingsSentFor.size < SYMBOL_SIBLINGS_MAX_PER_TURN && /^(write|edit|multi_edit)$/.test(name)) {
          const edited = String(effectiveArgs.path ?? effectiveArgs.file_path ?? "");
          if (edited && !this.symbolSiblingsSentFor.has(edited)) {
            const root = (this.lastCwd || process.cwd()).replace(/\\/g, "/");
            const abs = edited.replace(/\\/g, "/");
            const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : edited;
            /**
             * **根目录下的文件不占额度**（第 134 波）✓ —— 那是 agent 自己写的临时脚本
             * （真机日志里全是 `tmp-*.mjs` ✗），既不会有同族判据 ✓，还会把每回合 4 个名额吃光 ✗，
             * 于是等它去编辑 `src/core/llm/tools.ts` 时已经没机会了 ✗（repo-02 因此 0/4 ✗）。
             *
             * ⚠️ 必须在**标记之前**判断 ✓ —— 否则额度照样被吃掉 ✗。
             */
            if (!rel.replace(/\\/g, "/").includes("/")) {
              debugLog("agent-loop", "symbol siblings: 跳过（根目录文件，不占额度）:", rel);
            } else {
              /**
               * **整个会话的账**（第 154 波 ✓）：收尾守卫要用它算"同族判据有没有跑过"
               * （`unrunSiblingCriteria` ✓）。测试文件**不计** ✓ —— 改判据不用提醒去跑别的判据 ✓。
               */
              if (!/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) this.sessionEditedSources.add(rel);
              /** 先标记再做事（老规矩 ✓）：同一个文件本回合只尝试一次 ✓，失败也不重试 ✓。 */
              this.symbolSiblingsSentFor.add(edited);
              try {
                const { buildSymbolSiblings } = await import("./task-keyword-search");
                const siblings = await buildSymbolSiblings(this.lastCwd || process.cwd(), rel);
                debugLog("agent-loop", "symbol siblings:", siblings ? `${siblings.length} chars` : "null", "| edited=", rel);
                if (siblings) result.output = `${result.output}\n\n${siblings}`;
              } catch (sibErr) {
                console.warn("[AgenticLoop] symbol siblings failed:", sibErr);
              }
            }
          }
        }

        console.log(`[AgenticLoop] Tool executed: ${name}, path: ${effectiveArgs.path || effectiveArgs.command || "(none)"}, output length: ${result.output?.length || 0}`);

        // S0-2: PostToolUse hooks are now handled by HookPostExecuteMiddleware
        // in the pipeline's post-execute layer. Do NOT duplicate them here.

        // ===== Update state after tool execution =====
        // Record read content for future cache hits (with the range it was read with,
        // so a later read of a different range does not reuse it)
        if ((name === "read" || name === "read_file") && filePath && result.output) {
          this.readCache.set(filePath, {
            offset: readOffset,
            limit: readLimit,
            lineNumbers: readLineNumbers,
            output: result.output,
          });
        }
        // Record written content and invalidate read cache for that file
        if ((name === "write" || name === "edit" || name === "multi_edit") && filePath &&
            result.output && result.output.includes("Successfully")) {
          if (name === "write" && typeof effectiveArgs.content === "string") {
            this.writeCache.set(filePath, effectiveArgs.content);
          } else {
            // For edit/multi_edit, we don't know the full final content, so just invalidate
            this.writeCache.delete(filePath);
          }
          // File changed — read cache is stale
          this.readCache.delete(filePath);
        }

        // Track waited delegation results for cross-iteration deduplication (wait_for_subagent 已移除)
        if (name === "wait_for_delegation" && result.output) {
          const taskId = typeof args.task_id === "string" ? args.task_id : "";
          if (taskId) {
            this.waitedDelegations.set(taskId, result.output);
            this.delegatedTasks.delete(taskId);
          }
        }
        // DSH-style: subagent 工具不再返回 SUBAGENT_TASK_ID 格式。
        // 后台 subagent 的 settlement 通知由 SubagentRuntime 自动注入 inbox。
        // 追踪后台子智能体 — 用于保持 agentic-loop 存活直到 settlement 到达
        if (name === "subagent" && result.metadata) {
          const subagentId = (result.metadata as any)?.subagentId as string;
          if (subagentId) {
            // DSH-style: 注册 settlement Promise，runtime dispose 时 resolve
            const gate = Promise.withResolvers<void>();
            this.pendingBackgroundSubagents.set(subagentId, gate.promise);
            this.settlementResolvers.set(subagentId, () => gate.resolve());
            console.log(`[AgenticLoop] Registered settlement gate for background subagent: ${subagentId}`);
          }
        }
        // Track delegated task IDs to prevent endless delegation
        if (name === "delegate_to_session" && result.output) {
          // Extract task ID from the output (format: TASK_ID: del-xxx)
          const match = result.output.match(/TASK_ID:\s*(del-[^\s\n]+)/);
          if (match && match[1]) {
            this.delegatedTasks.add(match[1]);
            console.log(`[AgenticLoop] Tracked delegated task: ${match[1]} (total un-waited: ${this.delegatedTasks.size})`);
          }
        }

        // BASH/PROCESS INVALIDATION: bash commands can modify arbitrary files
        // on disk. We cannot know which files were touched, so the safest action
        // is to clear the entire readCache after a successful bash/execute_command
        // execution. This prevents stale cache hits where the LLM runs a script
        // that writes a file, then reads that file and gets the OLD cached content.
        // Trade-off: the LLM may re-read a few files unnecessarily, but that is
        // far better than silently working with stale data (which caused the
        // _refs_all.txt CACHE HIT bug where 45-line old content was returned
        // after a script had already updated the file to 227 lines).
        if ((name === "bash" || name === "execute_command" || name === "shell" || name === "run_command") &&
            result.output && this.readCache.size > 0) {
          const clearedCount = this.readCache.size;
          this.readCache.clear();
          console.log(`[AgenticLoop] Cleared readCache (${clearedCount} entr${clearedCount === 1 ? 'y' : 'ies'}) after bash execution — files on disk may have changed`);
        }

        // S4: Detect write rejection — set flag to stop the loop
        // 必须限定为 write 工具本身的拒绝输出："User rejected the overwrite"
        // 是 write 工具在用户拒绝覆盖时返回的错误文本。任何其他工具（如
        // read/grep/bash）的输出若恰好包含该字符串（例如读取本项目源码
        // tools.ts，其代码中就有这行字面量），之前会被误判为用户拒绝了
        // 写入，导致循环提前停止并输出"写入已被拒绝"（与安全模式无关，
        // ask/auto/full 全部失效、无审批弹窗）。
        if (
          name === "write" &&
          typeof args.path === "string" &&
          result.output &&
          result.output.includes("User rejected the overwrite")
        ) {
          this.state.writeRejected = true;
          console.warn(`[AgenticLoop] Write to ${args.path} was rejected by user. Loop will stop after this iteration.`);
        }
        // S4: After a successful write, append guidance to tool result (not as a separate message)
        // This ensures the LLM sees the guidance in the tool result, and no broken UI message is created
        if ((name === "write" || name === "edit" || name === "multi_edit") &&
            result.output && result.output.includes("Successfully wrote") &&
            typeof args.path === "string") {
          result.output += `\n\n[Guidance] 写入已成功完成。请勿重复写入同一文件。请直接向用户报告结果并结束任务，不要再调用任何工具。`;
        }
        // 第 84 波（B 类缺陷）：原来这里**无条件**写 "completed" ——
        // 工具把失败写成 `Error: ...` 文本时，界面/守卫/上层委派全都以为成功了。
        // errorSource:"tool" 让执行器知道这是"工具自己汇报的失败"（模型可自行纠正），
        // 不要按执行层异常处理（那会累加 consecutiveErrors 并可能提前终止整轮）。
        const verdict = classifyToolResult(name, result.output, result.isError);
        return {
          id: "",
          name,
          input: args,
          output: result.output,
          /**
           * 第 97 波：**必须把工具产出的结构化 `value` 透传下去**。
           *
           * 这里原来是重建一个"干净"的结果对象，只带 `id/name/input/output/status/metadata` ——
           * 于是工具自己产出的 `value` 在这一层被丢掉，而下游的
           * `OutputContractValidationMiddleware` 正是靠 `result.value` 做校验：
           * 「声明了 outputSchema 却没有 value」被判成**实现漏了**，把**成功结果改写成 error**。
           *
           * 真机后果（`.preview-shot/_probe-tool-health.mjs`，按事件顺序配对统计）：
           * `bash` 46 次调用 42 条 error、`read` 11 次 8 条、`glob` 7 次 7 条、`grep` 2 次 2 条，
           * 模型看到的是 `Error: bash declared outputSchema but returned no value` 这种内部话术，
           * 于是绕道 `terminal_*` 或直接宣布做不到 —— **四个主力工具在真机上等于废掉**。
           *
           * 为什么既有判据没抓到：`tool-contract-pipeline-e2e.test.ts` 的夹具 handler 自己写了
           * `value: out.value`（测试比生产"更对"），判据长在一条**生产里不执行**的链路上。
           * 现在的行为判据是 `src/test/output-contract-real-loop.test.ts`（驱动真实循环）。
           */
          value: result.value,
          ...(verdict.status === "error"
            ? { status: "error" as const, error: verdict.error, errorSource: "tool" as const }
            : { status: "completed" as const }),
          metadata: result.metadata,
        };
      },
    )) {
      switch (event.type) {
      case "tool_start":
        // Skip — already yielded during streaming phase to preserve LLM output order
        // P1: Record trajectory — tool call start
        this.recordTrajectory(sessionId, "tool_call", {
          name: event.toolCall.name,
          args: JSON.stringify(event.toolCall.input).substring(0, 300),
          iteration: this.state.iteration,
        });
        break;

        case "tool_complete":
          // Just yield - App.tsx handles persistence via useAppStore
          yield event;
          this.state.consecutiveErrors = 0;
          // P1: Record trajectory — tool result
          this.recordTrajectory(sessionId, "tool_result", {
            name: event.toolCall.name,
            result: (typeof event.result === 'string' ? event.result : JSON.stringify(event.result)).substring(0, 300),
            iteration: this.state.iteration,
          });
          break;

        case "tool_error":
          // Just yield - App.tsx handles persistence via useAppStore
          yield event;
          this.state.consecutiveErrors++;
          // P1: Record trajectory — tool error
          this.recordTrajectory(sessionId, "error", {
            name: event.toolCall.name,
            error: event.error?.substring(0, 300),
            iteration: this.state.iteration,
          });
          break;
      }
    }

    // If ALL tool calls in this iteration were cache hits (no new work done),
    // treat as a no-op iteration so the main loop checks stop conditions.
    // This prevents infinite loops where the LLM repeatedly calls wait_for_subagent
    // (or read/write) for already-completed tasks — the cache returns results but
    // the loop never stops because toolCallsInIteration > 0.
    if (cacheHitCount > 0 && cacheHitCount === this.state.toolCallsInIteration) {
      console.log(`[AgenticLoop] All ${cacheHitCount} tool calls were cache hits — treating as no-op iteration`);
      this.state.toolCallsInIteration = 0;
    }
  }

  /**
   * E3 + E6: Build messages with incremental caching and intelligent context selection.
   *
   * E3 (Incremental): Caches converted LLM messages. On subsequent calls:
   *   - If message count unchanged and last message fingerprint matches → return cache (O(1))
   *   - If new messages appended → only convert the delta (last cached msg + new msgs)
   *   - If message count decreased (compaction) → full rebuild
   *
   * E6 (Intelligent Selection): When context exceeds budget, uses priority-based retention:
   *   - Priority 4 (CRITICAL): Compaction markers — always keep
   *   - Priority 3 (HIGH): User messages — always keep (preserves original intent)
   *   - Priority 2 (MEDIUM): Recent assistant+tool messages
   *   - Priority 1 (LOW): Old tool results and assistant text — drop first
   */
  private async buildMessages(sessionId: string): Promise<any[]> {
    // DB CRUD is the single source of truth for LLM messages.
    // The event log (session_events table) is used for telemetry and audit only,
    // NOT for message projection — duplicate events in the log caused repeated
    // messages that made the LLM re-answer previous questions.
    let messages: any[];
    messages = this.getMessageStorage().listMessages(sessionId);
    // Filter out soft-deleted (hidden) messages — these are kept in DB for
    // history viewing but must NOT be sent to the LLM.
    messages = messages.filter((m: any) => !m.hidden);

    // --- E3: Incremental message building ---
    // Fingerprint MUST include tool call statuses + result presence, because
    // tool calls transition from "running" → "done" without changing message count,
    // content length, or toolCalls.length. Without this, the cache returns stale
    // messages where tool results are missing, causing the LLM to retry tool calls.
    const lastRaw = messages[messages.length - 1];
    const toolCallSig = lastRaw?.toolCalls
      ? lastRaw.toolCalls.map((tc: any) => `${tc.status}:${tc.result ? '1' : '0'}`).join(',')
      : '';
    const lastFingerprint = lastRaw
      ? `${lastRaw.id}:${lastRaw.content.length}:${lastRaw.toolCalls?.length || 0}:${lastRaw.status}:${toolCallSig}`
      : "";

    let llmMessages: any[];

    if (
      this.msgCache &&
      this.msgCache.sessionId === sessionId &&
      this.msgCache.rawCount === messages.length &&
      this.msgCache.rawLastId === (lastRaw?.id || "") &&
      this.msgCache.rawLastFingerprint === lastFingerprint
    ) {
      // Cache hit — no changes since last build (same iteration, multiple calls)
      llmMessages = [...this.msgCache.llmMessages];
    } else if (
      this.msgCache &&
      this.msgCache.sessionId === sessionId &&
      messages.length > this.msgCache.rawCount
    ) {
      // New messages appended — incremental conversion
      // Re-convert from the last cached raw message (it may have been updated during streaming)
      const staleFromRaw = Math.max(0, this.msgCache.rawCount - 1);
      const newMessages = messages.slice(staleFromRaw);
      const newLLM = this.convertMessagesToLLM(newMessages);

      // Find where to splice in the LLM array — locate the LLM message
      // that corresponds to the stale raw message
      const staleRawId = messages[staleFromRaw]?.id;
      let spliceIdx = this.msgCache.llmMessages.length;
      if (staleRawId) {
        const idx = this.msgCache.llmMessages.findIndex(
          (m) => m.id === staleRawId || (typeof m.id === "string" && m.id.startsWith(`${staleRawId}-tool-`)),
        );
        if (idx >= 0) spliceIdx = idx;
      }

      llmMessages = [
        ...this.msgCache.llmMessages.slice(0, spliceIdx),
        ...newLLM,
      ];

      this.msgCache = {
        sessionId,
        rawCount: messages.length,
        rawLastId: lastRaw?.id || "",
        rawLastFingerprint: lastFingerprint,
        llmMessages: [...llmMessages],
      };
    } else {
      // Full rebuild — first call, session change, or compaction (count decreased)
      llmMessages = this.convertMessagesToLLM(messages);
      this.msgCache = {
        sessionId,
        rawCount: messages.length,
        rawLastId: lastRaw?.id || "",
        rawLastFingerprint: lastFingerprint,
        llmMessages: [...llmMessages],
      };
    }

    // --- E6: Intelligent context selection ---
    // 2026-09 token 审计：预算对齐模型真实窗口（tracker.contextWindow，可由
    // provider.listModels 解析），不再用固定 100000 伪 token（=400k 字符，中文
    // 可超真实窗口致服务端截断/400）。窗口 90% 兜底 —— 压缩（0.8 阈值）先于
    // 它触发，select 仅在压缩后仍超限时做最后防线。
    // 先裁剪陈旧超大工具结果（保留最近 2 条完整；对标 dsh tool-result-pruner
    // head/tail 策略，防止单个 read/bash 结果 ≈12-25k token 占据大量预算）。
    const prunedForSelect = pruneStaleToolResults(llmMessages);
    const contextWindow = getTokenTracker().getContextWindow() || this.config.contextWindow || 128000;
    const selectBudgetTokens = Math.max(16_000, Math.round(contextWindow * 0.9));
    const selected = this.selectMessagesByPriority(prunedForSelect, selectBudgetTokens);

    // Filter orphan tool messages AND strip dangling tool_calls
    // 1. If a "tool" message has no preceding assistant with tool_calls → drop it
    // 2. If an assistant has tool_calls but its tool results were dropped by selection
    //    → strip tool_calls from the assistant so the LLM doesn't see "pending" tool calls
    //    and retry them (root cause of tool call loops)
    // 3. (FIX) If an assistant declares N tool_calls but only M<N results survived
    //    context selection, keep ONLY the M fulfilled tool_calls and drop the rest —
    //    otherwise the API rejects the payload with 400 "insufficient tool messages
    //    following tool_calls message" (DeepSeek/OpenAI strict pairing requirement).
    //    Previously we only checked whether ANY tool result followed the assistant,
    //    so a partially-truncated pair slipped through.
    const declaredToolCallIds = new Set<string>();
    for (const msg of selected) {
      if (msg.role === "assistant" && (msg as any).tool_calls) {
        for (const tc of (msg as any).tool_calls) declaredToolCallIds.add(tc.id);
      }
    }
    const presentToolResultIds = new Set<string>();
    for (const msg of selected) {
      if (msg.role === "tool" && (msg as any).toolCallId) presentToolResultIds.add((msg as any).toolCallId);
    }

    const valid: any[] = [];
    /**
     * 第 122 轮 B 项：这两处剥离原来**只写 console.warn**（用户在界面上完全看不到），
     * 而它们正是"模型突然忘了自己调过什么工具"的直接原因。计数后交给
     * `context-visibility` 投给界面（见下面 `recordContextDrop` 的注释）。
     */
    let strippedToolCallMessages = 0;
    let strippedToolCalls = 0;
    for (const msg of selected) {
      if (msg.role === "tool") {
        // Drop orphan tool results — no assistant in the selected window declares this tool_call_id.
        // Keeping them triggers API 400 "missing field tool_call_id" (a tool message must
        // immediately follow the assistant message that declared its tool_call).
        if ((msg as any).toolCallId && declaredToolCallIds.has((msg as any).toolCallId)) {
          valid.push(msg);
        }
        continue;
      }
      if (msg.role === "assistant" && (msg as any).tool_calls && (msg as any).tool_calls.length > 0) {
        // Keep only tool_calls that actually have a surviving result; strip unfulfilled ones.
        const matched = (msg as any).tool_calls.filter((tc: any) => presentToolResultIds.has(tc.id));
        if (matched.length === 0) {
          // No results at all → strip tool_calls entirely; the LLM only sees the text content.
          const { tool_calls, ...rest } = msg;
          valid.push(rest);
          strippedToolCallMessages++;
          strippedToolCalls += (msg as any).tool_calls.length;
          console.warn(`[buildMessages] Stripped dangling tool_calls from assistant ${msg.id} (tool results were dropped by context selection)`);
        } else if (matched.length !== (msg as any).tool_calls.length) {
          // Partial results → keep only the fulfilled tool_calls so the API pairing is exact.
          valid.push({ ...msg, tool_calls: matched });
          strippedToolCallMessages++;
          strippedToolCalls += (msg as any).tool_calls.length - matched.length;
          console.warn(`[buildMessages] Stripped ${(msg as any).tool_calls.length - matched.length} unfulfilled tool_calls from assistant ${msg.id} (results dropped by context selection)`);
        } else {
          valid.push(msg);
        }
        continue;
      }
      valid.push(msg);
    }

    // --- 上下文折叠（防"失忆"重复劳动 → 省 token）---
    // selectMessagesByPriority 超预算时会丢弃最早消息（无摘要）。对长任务，
    // 被丢的是早期 read/grep/bash 结果与旧轮次 —— 模型失忆后会重新读取/
    // 重复执行，消耗反而随轮次膨胀。这里在截断发生后，为被丢弃的操作插入
    // 一条零成本紧凑摘要（不调 LLM），保留下文可读。已存在折叠行则跳过
    // （避免每轮重复累积）。对标 dsh compaction 的语义化替换思想。
    let droppedCount = 0;
    let droppedStats: ReturnType<typeof foldStats> | null = null;
    let foldInserted = false;
    if (valid.length > 0 && llmMessages.length > valid.length) {
      const dropped = llmMessages.filter((m: any) => !valid.includes(m));
      droppedCount = dropped.length;
      if (dropped.length > 0) {
        droppedStats = foldStats(dropped);
        if (!valid.some((m: any) => isFoldMessage(m))) {
          const foldMsg = renderFoldSummary(droppedStats, "zh");
          valid.unshift({ role: "user", content: foldMsg, id: `ctx-fold-${Date.now()}` } as any);
          foldInserted = true;
        }
      }
    }

    /**
     * ## 第 122 轮 B 项：把"这一轮丢了什么"**同时**投给界面
     *
     * 上面那条 `[上下文精简]` 摘要只进了**模型**的消息数组（`valid`），不落库、
     * 不上界面；`3138`/`3142` 那两处剥离更是只写 `console.warn`。
     * 结果是：模型少了半截上下文，用户只看到"回答变差了" —— 归因必然是「模型不行」。
     *
     * 这里把**已经算出来的同一份事实**投给 `context-visibility`，
     * 由水位提示条把"再这样下去会丢"改成"这一轮已经丢了"。
     * ⚠️ 纯通知：`recordContextDrop` 内部吞掉所有异常，不影响本函数的返回值。
     */
    if (droppedCount > 0 || strippedToolCallMessages > 0) {
      recordContextDrop(this.currentSessionId ?? "", {
        droppedMessages: droppedCount,
        toolCounts: droppedStats?.toolCounts ?? {},
        strippedToolCallMessages,
        strippedToolCalls,
        foldSummaryInserted: foldInserted,
      });
    }

    // P0-3: Micro-compact — replace old tool result content with placeholders
    // to reduce context pressure without expensive LLM summarization.
    // This runs BEFORE the pressure check in run(), so if micro-compact
    // reduces pressure enough, full compaction is avoided.
    // Pressure-driven: only prune when the context is actually crowded
    // (message count AND estimated pressure above thresholds). With a
    // model-aware contextWindow, low-pressure sessions keep full detail.
    let finalMessages = valid;
    if (valid.length > KEEP_RECENT_MESSAGES_FOR_MICRO_COMPACT) {
      const prePressure = this.estimateContextPressure(valid);
      if (prePressure >= MICRO_COMPACT_PRESSURE_THRESHOLD) {
        const { microCompact } = await import("./micro-compact");
        /**
         * 第 84 波（审计修正）：这里原来用 `isAlreadyMicroCompacted(valid)` 当闸门 ——
         * 那个函数只会回答"列表里**是否出现过**占位符"。于是一旦压缩过一次，
         * 后续即使又积累了成百上千条新的工具结果也不会再压（"已经是压缩过的了"），
         * 上下文压力照样顶满。
         *
         * `microCompact` 本身是**幂等**的：它内部会跳过已经是占位符的消息
         * （见 micro-compact.ts 的 `[Tool result pruned …]` 跳过分支），
         * 没有可压的就返回 compactedCount=0。所以直接让它自己判断更准确，
         * 也去掉了这个语义错误的闸门。
         */
        const microResult = microCompact(valid);
        if (microResult.compactedCount > 0) {
          finalMessages = microResult.messages;
          this.state.microCompactedThisRun = true;
        }
      }
    }

    debugLog("agent-loop", `buildMessages raw: ${messages.length}, llm: ${llmMessages.length}, selected: ${valid.length}, final: ${finalMessages.length}`);
    // Diagnostic: 逐条 dump 仅在调试模式输出 — 长会话（数百条消息）每次迭代
    // 全量打印产生数千行 console 噪音，拖慢 devtools 且掩盖真实错误。
    // 设置 DEBUG_BUILD_MESSAGES=1 可恢复逐条诊断。
    if (typeof process !== "undefined" && process.env?.DEBUG_BUILD_MESSAGES === "1") {
      for (const m of finalMessages) {
        if (m.role === "tool") {
          console.log(`  [buildMessages] tool result: toolCallId=${m.toolCallId}, content_len=${(m.content || "").length}, preview=${(m.content || "").substring(0, 120)}`);
        } else if (m.role === "assistant" && m.tool_calls) {
          console.log(`  [buildMessages] assistant ${m.id}: tool_calls=[${m.tool_calls.map((tc: any) => tc.function?.name).join(",")}], content_len=${(m.content || "").length}`);
        } else if (m.role === "user") {
          console.log(`  [buildMessages] user ${m.id}: content_len=${(m.content || "").length}, preview=${(m.content || "").substring(0, 80)}`);
        }
      }
    }
    return finalMessages;
  }

  /** Convert raw DB messages to LLM API format, stripping system-reminder tags and stale custom instructions */
  private convertMessagesToLLM(messages: any[]): any[] {
    const llmMessages = this.getMessageStorage().messagesToLLMMessages(messages);
    for (const msg of llmMessages) {
      if (typeof msg.content === "string") {
        // Strip system-reminder tags
        msg.content = msg.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        // Strip stale custom instructions from old tool results — these cause the LLM to
        // carry over one-time instructions (e.g., "append not overwrite") to future writes,
        // creating confusion and loops. Replace with a neutral summary.
        if (msg.role === "tool" && msg.content.includes("User gave") && msg.content.includes("custom instruction")) {
          msg.content = "[This write was not executed — user provided a one-time instruction that was already handled in that iteration. No action needed.]";
        }
      }
    }
    return llmMessages;
  }

  /**
   * E6: Priority-based message selection when context exceeds token budget.
   *
   * 第 47 轮（P2-D8/D12）：实现搬到 `compaction-budget.ts::selectMessagesByPriority` ——
   * `ContextMonitor` 面板要显示"模型实际收到的上下文占用"，就必须与循环用**同一份**
   * 选择算法；两份实现在这种地方必然分叉（面板显示 130%、模型其实只收到一半）。
   * 这里保留薄封装，语义与抽取前逐字一致。
   */
  private selectMessagesByPriority(messages: any[], maxTokens: number): any[] {
    return selectMessagesByPriority(messages, maxTokens);
  }

  /**
   * Resolve the current model's real context window and sync it into
   * TokenTracker. Uses the provider's model list (dynamic + static).
   * Falls back to the configured default when the model is unknown.
   */
  private async resolveModelContextWindow(): Promise<void> {
    try {
      const model = this.config.model || (this.provider as any).id;
      const models = await this.provider.listModels();
      const match = models.find((m: any) => m.id === model);
      if (match?.contextWindow) {
        getTokenTracker().setContextWindow(match.contextWindow);
        console.log(`[AgenticLoop] Model-aware context window: ${model} = ${match.contextWindow} tokens`);
      }
    } catch (e) {
      console.warn(`[AgenticLoop] Failed to resolve context window (keeping default):`, e);
    }
  }

  private estimateContextPressure(messages: any[]): number {
    // R3-1.6: Use TokenTracker for more precise estimation
    const tracker = getTokenTracker();
    const toolCount = (this as any).currentToolDefs?.length || 0;
    const tools = (this as any).currentToolDefs || [];
    
    // Try tracker's pressure estimation (uses actual usage if available)
    return tracker.estimatePressure(messages, tools);
  }

/**
 * P4: Check if the current session has any document attachments.
 * Only document attachments (file/code/url, NOT image) warrant the
 * read_attachment tool — images go through the vision channel.
 *
 * Attachments are now persisted in the DB (attachments table with message_id),
 * so listMessages returns them. A content-based fallback covers legacy messages
 * that were saved before attachments were persisted.
 */
private checkHasDocumentAttachment(sessionId: string): boolean {
  try {
    const messages = this.getMessageStorage().listMessages(sessionId);
    for (const msg of messages) {
      // 1. Check attachments array (persisted in DB)
      if (msg.attachments && msg.attachments.length > 0) {
        for (const att of msg.attachments) {
          if (att.type === "file" || att.type === "code" || att.type === "url") {
            return true;
          }
        }
      }
      // 2. Fallback: check inline <attachment> tags in content (legacy messages)
      if (msg.role === "user" && msg.content && msg.content.includes("<attachment>")) {
        if (!msg.content.includes("Truncated: n/a (image)")) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

  /**
   * Compact messages for a session using LLM-powered summarization.
   *
   * Strategy:
   * 1. Split messages into "to summarize" (old) and "to keep" (recent)
   * 2. Check if there's an existing compaction marker — include its content
   *    as prior summary context for cascading compaction
   * 3. Call LLM to generate a structured summary of old messages
   * 4. Delete old messages + old marker from DB
   * 5. Insert new compaction marker with the LLM-generated summary
   *
   * This enables "summary of summaries" — repeated compaction preserves
   * key context across many days of conversation.
   */
  private async compactMessages(sessionId: string): Promise<number> {
    // R3-3.3: Acquire compaction lock — prevent concurrent compaction
    const { acquireCompactionLock, releaseCompactionLock } =
      await import("./compaction-control");
    if (!acquireCompactionLock(sessionId)) {
      console.log("[compactMessages] Compaction already in progress, skipping");
      return 0;
    }

    try {
      const result = await this.doCompactMessages(sessionId);
      return result;
    } finally {
      releaseCompactionLock(sessionId);
    }
  }

  /**
   * 把"保留最近 N 条"对齐到安全的轮次边界（第 83 波；实现搬进 compaction-budget.ts，
   * 那边有独立用例守着，这里只保留薄封装供循环内部调用）。
   */
  private alignKeepBoundary(messages: any[], desiredCount: number): number {
    return alignKeepToRoundBoundary(messages, desiredCount);
  }

  /**
   * 第 47 轮（P2-D13）：这里原来还有一个形参
   * `isBoundarySafe: (events, seq) => {…}`，由 `compaction-control.isCompactionBoundarySafe`
   * 传进来 —— **函数体里一次都没用过**（于是"事件日志侧的配对边界检查"在这条路径上
   * 形同虚设，而读代码的人会以为它在检查）。已删除；真实消费者清单写在
   * `compaction-control.ts::isCompactionBoundarySafe` 的注释里（唯一真消费者是
   * `repairCrashedSession`）。消息侧的边界对齐由 `alignKeepBoundary` 负责。
   */
  private async doCompactMessages(sessionId: string): Promise<number> {
    const allMessages = this.getMessageStorage().listMessages(sessionId);
    // Only consider visible (non-hidden) messages for compaction
    const messages = allMessages.filter((m: any) => !m.hidden);
    if (messages.length <= 2) return 0;

    // API-Round aware boundary detection:
    // Instead of a fixed keepCount, find a safe boundary that doesn't
    // split tool_use/tool_result pairs. We scan backwards from the end,
    // tracking which messages belong to the same assistant API round
    // (same assistant message ID = same round). The boundary is placed
    // at the start of the oldest round we want to keep.
    const maxKeepCount = Math.min(20, messages.length);
    let keepCount = this.alignKeepBoundary(messages, maxKeepCount);

    /**
     * 第 83 波：**按体积收缩保留集**（原来是固定"保留最近 20 条"，完全不看大小）。
     *
     * 用户现场：会话 861 条、压缩后仍 ~105 万 token，迭代 1→2→3→4 反复压缩 —— 因为
     * "最近 20 条"本身就可能有几十万 token（一条大文件读取/大段粘贴就能顶满），
     * 固定条数的压缩**永远压不到窗口之内**，只能白烧摘要调用然后硬停。
     *
     * 这里改成：估算保留集的 token，超过预算就成半收缩（仍对齐轮次边界），
     * 直到进预算或触到下限。仍压不下去时如实记日志 —— 那种情况（单条消息本身就超窗口）
     * 任何压缩都救不了，必须让用户看到"开新对话/改用附件"的明确结论。
     */
    const windowTokens = getTokenTracker().getContextWindow() || this.config.contextWindow || 128000;
    // 预算：窗口的一半。留一半给系统提示、工具 schema、以及模型输出。
    const keepBudget = Math.max(8000, Math.floor(windowTokens * 0.5));
    const estimateKeepTokens = (count: number): number =>
      messages
        .slice(-count)
        .reduce((sum: number, m: any) => sum + estimateTokens(String(m.content ?? "")), 0);
    const plan = planCompactionKeep({
      totalMessages: messages.length,
      desiredKeep: maxKeepCount,
      budget: keepBudget,
      minKeep: MIN_KEEP_MESSAGES,
      estimate: estimateKeepTokens,
      align: (desired) => this.alignKeepBoundary(messages, desired),
    });
    keepCount = plan.keepCount;
    if (plan.shrunk) {
      console.log(
        `[compactMessages] 保留集按体积收缩：${plan.initialKeep} → ${plan.keepCount} 条（估算 ${plan.estimated} tokens，预算 ${keepBudget}，窗口 ${windowTokens}）`,
      );
    }
    if (plan.overBudget) {
      console.warn(
        `[compactMessages] 即使保留 ${plan.keepCount} 条仍超出预算（估算 ${plan.estimated} > ${keepBudget}）：` +
          `单条消息本身过大时压缩无法解决，将由循环按"压缩无效"上报（建议开新对话或改用附件）。`,
      );
      /**
       * 第 83 波：既然压缩救不了，就别再白烧两次摘要调用。
       * 把连压计数直接顶到上限，循环下一轮就按"上下文装不下"给出可执行的建议
       * （用户现场：压缩 → 仍溢出 → 再压缩，迭代 1→2→3→4 全是无用功）。
       */
      this.state.consecutiveCompactions = 3;
    }

    let messagesToKeep = messages.slice(-keepCount);
    let messagesToRemove = messages.slice(0, messages.length - keepCount);

    if (messagesToRemove.length === 0) return 0;

    /**
     * 第 45 轮（功能上下文审计 P1-D4 / C13）：**把保留集里的旧摘要标记折叠进待删集。**
     *
     * 原来只从"待删集"里找旧标记（见下面 `findIndex`）。而标记是一条普通可见 user 行，
     * 一旦它落在保留集里（用户现场形态：一条大文件读取/大段粘贴就能把上下文顶到阈值，
     * 于是"标记之后的消息条数"少于保留条数）：
     *  - `existingSummary` 恒为空 → "摘要的摘要"在最常见的形态下失效，早期上下文直接丢；
     *  - 旧标记永久留在上下文里（没有任何路径把它设为 hidden），与"压缩让上下文变小"相反。
     *
     * 折叠规则与理由见 `foldStaleCompactionMarkers`（纯函数，有用例守着）。
     */
    const folded = foldStaleCompactionMarkers(messages, keepCount);
    if (folded.foldedMarkers > 0) {
      console.log(
        `[compactMessages] 折叠保留集里的旧摘要标记 ${folded.foldedMarkers} 条：保留 ${keepCount} → ${folded.keepCount} 条（否则摘要永远累积、级联永远失效）`,
      );
      keepCount = folded.keepCount;
      messagesToKeep = messages.slice(-keepCount);
      messagesToRemove = messages.slice(0, messages.length - keepCount);
      if (messagesToRemove.length === 0) return 0;
    }

    // Verify tool_use/tool_result pairing integrity in the keep set
    // If a tool_result in keep references a tool_use in remove, we need to
    // also keep that tool_use (or remove the orphan tool_result)
    const removeToolCallIds = new Set<string>();
    for (const msg of messagesToRemove) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.id) removeToolCallIds.add(tc.id);
        }
      }
    }
    // Check if any kept message references a removed tool_use
    // (This is rare with proper boundary detection, but serves as a safety net)

    /**
     * 级联摘要的输入：**待删集里最新的一条摘要标记**（折叠之后，保留集里的标记也在里面了）。
     *
     * 为什么取"最新"而不是原来那个 `findIndex`（第一条）：每次压缩写出的标记正文
     * 是"上一次摘要 + 本次新增对话"的合并结果，所以**越靠后的标记越完整**；
     * 取最旧的那条等于把后来几十轮的工作摘要丢掉。前缀判定用共享的
     * `COMPACTION_MARKER_PREFIXES`（自动/手动两种标记都认 —— 原来只认自动那一种，
     * 手动压缩写的 `[上下文已手动压缩]` 因此永远折叠不了）。
     */
    const existingSummary = folded.existingSummary;
    if (existingSummary) {
      console.log(`[compactMessages] Found existing compaction marker (cascade input, ${existingSummary.length} chars)`);
    }

    // Build conversation text for the LLM to summarize
    const conversationText = this.buildConversationText(messagesToRemove);

    // P-OPT1: Cache-aware compaction — replay the current system prompt
    // and tools schema as prefix so the provider's KV cache is reused.
    // Only the compaction instruction is new input, minimizing cache miss.
    const compactionInstruction = `你是一个对话摘要专家。请将以上对话内容浓缩为结构化的检查点，让另一个模型可以无损恢复工作。

请输出 EXACTLY 以下 Markdown 结构，保持每个部分，按顺序：

## 主要请求和意图
- [用户原始和演进的目标]

## 关键技术和概念
- [涉及的技术、框架、模式和约定]

## 文件和代码
- [精确路径：为何重要、关键变更或片段]

## 错误和修复
- [错误：如何解决的，以及相关用户反馈]

## 待办任务
- [明确请求但尚未完成的工作]

## 当前工作
- [压缩点正在进行的精确工作]

## 下一步
- [最直接的下一步行动，或"(无)"]

## 关键上下文
- [决策及理由、约束、用户偏好、开放问题]

规则：
- 用简洁的中文工程式写摘要
- 保留精确的文件路径、命令、错误字符串、标识符、数值
- 忠实捕获用户反馈和明确指示
- 不要提及这个摘要请求本身
- 只输出检查点文本，不调用任何工具`;

    // Generate LLM-powered summary
    // DSH design: all async work (LLM summarization) happens FIRST, then all
    // DB mutations are committed synchronously in one block with no `await`
    // gaps. This prevents the JS event loop from interleaving UI auto-save
    // (saveMessages → createMessage → db.run) between our compaction DB
    // operations, which corrupted sql.js state and caused
    // "bad parameter or other API misuse" errors.
    let summary: string;
    try {
      summary = await this.generateCompactionSummaryCacheAware(
        conversationText, existingSummary, compactionInstruction,
      );
    } catch (err) {
      console.warn("[compactMessages] LLM summary failed, falling back to snippet extraction:", err);
      summary = this.fallbackSummary(messagesToRemove);
    }

    // ========== ATOMIC DB COMMIT (no `await` from here to the end) ==========
    // Pre-resolve all dynamic imports so we never yield during DB mutation.
    // The compaction flag also blocks UI auto-save from touching the DB.
    const { getEventLog } = await import("../storage/event-log");
    const { setCompactionInProgress } = await import("../storage/compaction-state");
    const eventLog = this.getEventLog();
    const messageStorage = this.getMessageStorage();
    const removedIds = messagesToRemove.map((m: any) => m.id);
    const markerContent = `[上下文已自动压缩]\n\n${summary}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条（API-Round 边界对齐）。请基于以上摘要和后续消息继续工作。不要重复已摘要中记录为完成的工作。如需之前的文件内容或命令输出，请使用工具重新获取。`;
    const markerTs = messagesToKeep[0]?.timestamp ?? Date.now();
    /**
     * ⚠️ 主键**必须**由 `nextCompactionMarkerId()` 生成，不能退回 `compact-${Date.now()}`。
     *
     * 标记写入前旧标记一定刚被软删（它永远在 `messagesToRemove` 里），所以"同一毫秒
     * 两次压缩"会让新标记写进那行已隐藏的 id：引擎保留 `hidden=1`
     * （`repo.rs:1018-1031`）、读路径又叠加 `localHiddenIds`（`message.ts:616`），
     * 结果是**摘要标记写成功但读不到**（偶发形态：连压两次后可见标记 0 条）。
     * 完整机制与跨会话形态见 `compaction-budget.ts` 的 `nextCompactionMarkerId`。
     */
    const markerId = nextCompactionMarkerId("auto");
    const messagesBefore = messages.length;
    const messagesAfter = keepCount + 1;

    // Set the compaction flag — UI auto-save (saveMessages) will skip while
    // this is active. This is a defense-in-depth measure; the primary fix is
    // that all DB operations below are synchronous with no `await` gaps.
    setCompactionInProgress(true);
    try {
      // Step 1: Soft-delete old messages (mark hidden=1)
      messageStorage.deleteMessagesByIds(removedIds);

      // Step 2: Insert compaction marker message
      messageStorage.createMessage({
        id: markerId,
        role: "user",
        content: markerContent,
        timestamp: markerTs - 1,
        status: "done",
      }, sessionId);

      // Step 3: Append compaction event to the event log
      try {
        eventLog.append(sessionId, "compaction", {
          removedMessageIds: removedIds,
          summary: markerContent,
          messagesBefore,
          messagesAfter,
        });
      } catch (eventErr) {
        console.warn("[compactMessages] Event log compaction write failed (non-critical):", eventErr);
      }
    } finally {
      // Release the compaction flag — UI auto-save can resume
      setCompactionInProgress(false);
    }

    console.log(`[compactMessages] Removed ${messagesToRemove.length} old messages, kept ${keepCount}, inserted LLM compaction marker (summary length: ${summary.length})`);
    return messagesToRemove.length;
  }

  /**
   * Build readable conversation text from messages for LLM summarization.
   */
  private buildConversationText(messages: any[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        const content = msg.content || "";
        /**
         * 摘要标记整体带进摘要输入（不做 500 字截断）：它是"已经压缩过一次"的完整结论，
         * 截断会让级联摘要丢内容。两种前缀都认（自动 / 手动，见
         * `compaction-budget.ts` 的 `COMPACTION_MARKER_PREFIXES`）。
         */
        if (isCompactionMarker(msg)) {
          // Include existing summary as-is for cascading
          parts.push(`[已有摘要]\n${content}`);
        } else if (content.trim()) {
          parts.push(`用户: ${boundOne(content, LLMEngineTextBounds.USER)}`);
        }
      } else if (msg.role === "assistant") {
        const content = boundOne(msg.content || "", LLMEngineTextBounds.ASSISTANT);
        if (content.trim()) parts.push(`AI: ${content}`);
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const argsStr = tc.args ? boundOne(JSON.stringify(tc.args), LLMEngineTextBounds.TOOL_ARGS) : "";
            const resultStr = tc.result
              ? (typeof tc.result === "string" ? boundOne(tc.result, LLMEngineTextBounds.TOOL_RESULT) : "")
              : "";
            parts.push(`工具[${tc.tool}]: ${argsStr} → ${resultStr}`);
          }
        }
      }
    }
    return parts.join("\n\n");
  }

  /**
   * P-OPT1: Cache-aware compaction summary.
   * Instead of using a dedicated system prompt, replays the current conversation
   * (system prompt + messages to compact) as the prefix, then appends the
   * compaction instruction as the final user message. This ensures the
   * provider's KV cache is reused — only the trailing instruction is novel.
   */
  private async generateCompactionSummaryCacheAware(
    conversationText: string,
    existingSummary: string,
    compactionInstruction: string,
  ): Promise<string> {
    const truncatedConv = boundConversationForSummary(conversationText);

    // Build user message: existing summary (if any) + new conversation + compaction instruction
    const userContent = existingSummary
      ? `这是之前对话的已有摘要：\n\n${existingSummary}\n\n---\n\n以下是新增的对话内容：\n\n${truncatedConv}\n\n---\n\n${compactionInstruction}`
      : `请为以下对话生成结构化摘要：\n\n${truncatedConv}\n\n---\n\n${compactionInstruction}`;

    // Use the same provider/model as the main conversation for prefix cache reuse
    const resolved = this.config.resolveProvider?.("compaction");
    const compactionProvider = resolved?.provider || this.provider;
    const compactionModel = resolved?.model || this.config.model || this.provider.id;
    const compactionTemperature = resolved?.temperature ?? 0.3;

    const request: LLMRequest = {
      model: compactionModel,
      messages: [
        { id: "system", role: "system", content: "你是一个对话摘要专家。" },
        { id: "user", role: "user", content: userContent },
      ],
      temperature: compactionTemperature,
      stream: false,
      abortSignal: this.abortController?.signal,
      purpose: "compaction", // P-OPT5: Enable server-side compaction optimization
    };

    const response = await compactionProvider.complete(request);
    return response.content;
  }

  /**
   * Generate a structured summary using the LLM.
   * If there's an existing summary (from prior compaction), it's included
   * as context so the LLM can merge old + new into a coherent summary.
   */
  private async generateCompactionSummary(conversationText: string, existingSummary: string): Promise<string> {
    // Truncate conversation text to avoid token overflow (max ~12K chars ≈ 3K tokens)
    const truncatedConv = boundConversationForSummary(conversationText);

    // P-OPT1: Cache-aware compaction — replay the current system prompt as prefix
    // instead of using a dedicated compaction system prompt. This ensures the
    // provider's KV cache is reused (prefix bytes are identical), dramatically
    // reducing TTFT and token processing cost for the compaction call.
    // The compaction instruction is appended as the final user message.
    const systemPrompt = `你是一个对话摘要专家。你的任务是为 AI 编程助手生成结构化的对话摘要，以便在上下文压缩后保留关键信息。

摘要必须包含以下部分（如果有的话）：

## 关键决策
用户和 AI 共同做出的重要技术决策、架构选择、方案取舍。

## 文件变更
被创建、修改、删除的文件列表，以及变更的核心内容。

## 用户偏好
用户表达的语言偏好、代码风格、工具选择、工作方式等。

## 未完成任务
已开始但尚未完成的工作，包括错误未修复、功能未实现等。

## 重要错误和修复
遇到的错误信息及解决方案。

## 项目上下文
项目的技术栈、目录结构、关键配置等背景信息。

规则：
- 用简洁的中文写摘要
- 每个条目一行，不要展开细节
- 如果已有前序摘要，将其内容合并到新摘要中（不要丢失前序信息）
- 总长度不超过 1500 字符
- 不要包含临时性信息（如中间步骤的调试输出）`;

    const userPrompt = existingSummary
      ? `这是之前对话的已有摘要：

${existingSummary}

---

以下是新增的对话内容，请将已有摘要和新对话内容合并，生成一个更新后的结构化摘要：

${truncatedConv}`
      : `请为以下对话生成结构化摘要：

${truncatedConv}`;

    // M1: Use "compaction" slot if resolveProvider is available
    const resolved = this.config.resolveProvider?.("compaction");
    const compactionProvider = resolved?.provider || this.provider;
    const compactionModel = resolved?.model || this.config.model || this.provider.id;
    const compactionTemperature = resolved?.temperature ?? 0.3;

    const request: LLMRequest = {
      model: compactionModel,
      messages: [
        { id: "system", role: "system", content: systemPrompt },
        { id: "user", role: "user", content: userPrompt },
      ],
      temperature: compactionTemperature, // Low temperature for factual summary
      stream: false,
      abortSignal: this.abortController?.signal,
    };

    const response = await compactionProvider.complete(request);
    return response.content;
  }

  /**
   * Fallback summary when LLM is unavailable (e.g., network error).
   * Uses the old snippet-extraction approach.
   */
  private fallbackSummary(messages: any[]): string {
    let summaryParts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        const snippet = (msg.content || "").substring(0, 100);
        if (snippet.trim() && !snippet.startsWith("[上下文已自动压缩]")) {
          summaryParts.push(`- 用户请求: ${snippet}`);
        }
      } else if (msg.role === "assistant") {
        const snippet = (msg.content || "").substring(0, 100);
        if (snippet.trim()) summaryParts.push(`- AI回复: ${snippet}`);
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            summaryParts.push(`- 工具调用: ${tc.tool}`);
          }
        }
      }
    }
    let summary = summaryParts.join("\n");
    if (summary.length > 1000) {
      summary = summary.substring(0, 1000) + "\n...(更多历史已省略)";
    }
    return `以下是之前对话的摘要：\n${summary}`;
  }

  private async ensureSnapshot(cwd: string, sessionId: string): Promise<void> {
    if (!this.currentSnapshotId || this.lastCwd !== cwd) {
      const snapshotService = this.getSnapshotService(cwd);
      const snapshot = await snapshotService.create(
        sessionId,
        this.state.iteration,
        `Auto-snapshot before tool execution`,
      );
      this.currentSnapshotId = snapshot.id;
      this.lastCwd = cwd;
    }
  }

  getCurrentSnapshotId(): string | null {
    return this.currentSnapshotId;
  }

  resetSnapshot(): void {
    this.currentSnapshotId = null;
  }

  /**
   * DSH-style: SubagentRuntime 在 dispose 时调用此方法，
   * resolve settlement Promise，唤醒正在 await 的 agentic-loop。
   * 替代旧的轮询检查 + 消息注入机制。
   */
  resolveSubagentSettlement(childId: string): void {
    const resolve = this.settlementResolvers.get(childId);
    if (resolve) {
      resolve();
      this.settledSubagentIds.add(childId);
      console.log(`[AgenticLoop] Settlement gate resolved for ${childId}`);
    }
  }

  abort() {
    this.abortController?.abort();
    this.executor.abortAll();
  }

  /**
   * Send a guidance message to the currently running agentic loop.
   * The message will be consumed at the next iteration boundary (before
   * the next LLM call), allowing the user to steer the agent mid-turn.
   *
   * If no run is active, the message is discarded (returns false).
   */
  sendGuidance(message: string): GuidanceItem | null {
    if (!this.currentSessionId) {
      console.warn("[AgenticLoop] Cannot send guidance — no active run");
      return null;
    }
    return this.guidanceQueue.enqueue(this.currentSessionId, message);
  }

  /**
   * Send a guidance message with immediate priority — it will be injected
   * at the very next iteration boundary, ahead of any other pending guidance.
   * Additionally, if the LLM is currently streaming a response, abort it
   * so the new guidance takes effect immediately.
   */
  sendGuidanceImmediate(message: string): GuidanceItem | null {
    if (!this.currentSessionId) {
      console.warn("[AgenticLoop] Cannot send guidance — no active run");
      return null;
    }
    // Insert at the front of the queue (high priority)
    const item = this.guidanceQueue.enqueuePriority(this.currentSessionId, message);
    // Set flag so AbortError handler knows this is a guidance interrupt, not a cancel
    this.guidanceInterrupt = true;
    // Abort current LLM stream so the loop re-enters and consumes guidance
    this.abortController?.abort();
    // Create a fresh AbortController for the next iteration
    this.abortController = new AbortController();
    return item;
  }

  /**
   * Interrupt the current LLM stream so the loop re-enters and consumes
   * already-queued guidance. Unlike sendGuidanceImmediate, this does NOT
   * enqueue a new message — used when the user taps "inject now" on an
   * already-pending guidance bubble.
   */
  interruptForGuidance(): boolean {
    if (!this.currentSessionId) {
      console.warn("[AgenticLoop] Cannot interrupt — no active run");
      return false;
    }
    // Set flag so AbortError handler knows this is a guidance interrupt, not a cancel
    this.guidanceInterrupt = true;
    // Abort current LLM stream so the loop re-enters and consumes queued guidance
    this.abortController?.abort();
    // Create a fresh AbortController for the next iteration
    this.abortController = new AbortController();
    return true;
  }

  /**
   * Check if there are pending guidance items waiting to be consumed.
   */
  hasPendingGuidance(): boolean {
    if (!this.currentSessionId) return false;
    return this.guidanceQueue.hasPending(this.currentSessionId);
  }

  getState(): Readonly<LoopState> {
    return { ...this.state };
  }

  updateConfig(config: Partial<LoopConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * 宏观步骤进度辅助方法 — 供测试使用。
   * Returns true when the given tool is a recon (read-only) tool that
   * must NOT advance the macro step counter.
   */
  static isReconTool(toolName: string): boolean {
    return RECON_TOOL_NAMES.has(toolName);
  }

  /** Human-readable Chinese title for a tool (step progress display). */
  static toolDisplayTitle(toolName: string): string {
    const titleMap: Record<string, string> = {
      read: "读取文件", write: "写入文件", edit: "修改文件", multi_edit: "批量修改文件",
      glob: "查找文件", grep: "搜索内容", bash: "执行命令", tool_search: "加载工具",
      web_search: "网络搜索", install: "安装依赖", run: "运行程序", build: "构建项目", test: "运行测试",
      read_file: "读取文件", write_file: "写入文件", edit_file: "修改文件", multi_edit_file: "批量修改文件",
      list_directory: "查看目录", search_code: "搜索代码", grep_search: "搜索代码",
      run_terminal_command: "执行命令", run_test: "运行测试", web_fetch: "获取网页",
      subagent: "委派子智能体", delegate_to_session: "委派会话", wait_for_delegation: "等待委派结果",
      query_session_result: "查询会话结果", list_sessions: "查看会话列表", cancel_delegation: "终止委派",
      create_file: "创建文件", delete_file: "删除文件", file_search: "搜索文件",
      todo_write: "更新任务", codebase_search: "搜索代码库", lsp: "代码导航",
    };
    return titleMap[toolName] || toolName;
  }

  /**
   * 计划耗尽后是否追加步骤 — 宏观计划步语义。
   * 只有出现新的执行类别（标题去重）且追加总数未达上限时才追加，
   * 防止中间小步骤让「第X/X步」总量无限膨胀。
   */
  static shouldAppendStep(appendedTitles: ReadonlySet<string>, toolName: string): boolean {
    const title = AgenticLoop.toolDisplayTitle(toolName);
    return !appendedTitles.has(title) && appendedTitles.size < AgenticLoop.MAX_APPENDED_STEPS;
  }
}
