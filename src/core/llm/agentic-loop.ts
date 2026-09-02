import type { LLMProvider, LLMRequest, ToolDefinition, TokenUsage } from "./types";
import type { ToolRegistry, ToolContext, WriteConfirmResult } from "./tools";
import type { PlanUpdateOp } from "./plan-utils";
import { applyPlanUpdate as applyPlanUpdatePure, looksLikeExecutableTask, renderPlanSection } from "./plan-utils";
import { foldStats, renderFoldSummary, isFoldMessage, pruneStaleToolResults } from "./context-fold";
import type { ToolExecutorConfig } from "./streaming-executor";
import { StreamingToolExecutorImpl, type StreamingToolCall } from "./streaming-executor";
import { initDefaultPipeline } from "./tool-pipeline";
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
  | { type: "stop"; reason: string; usage: TokenUsage }
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
const MAX_CONSECUTIVE_NO_PROGRESS = 30;

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
  // State-based tool deduplication — no timers, no thresholds
  // Tracks what files have been read/written in the CURRENT user request.
  // Reset at the start of each run() call (new user message = new task).
  private readCache: Map<string, { offset: number; limit: number; output: string }> = new Map();   // path → last read content (with its offset/limit range)
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
    if (this._ctx) { const s = this._ctx.get('permission'); if (s) return s; console.warn('[AgenticLoop] Service "permission" not available, falling back to singleton'); }
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
    if (this._ctx) { const s = this._ctx.get('telemetry'); if (s) return s; console.warn('[AgenticLoop] Service "telemetry" not available, falling back to singleton'); }
    return getTelemetry();
  }
  private getTranscriptCache() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('transcriptCache'); if (s) return s; console.warn('[AgenticLoop] Service "transcriptCache" not available, falling back to singleton'); }
    return TranscriptCache;
  }
  private getMessageStorage() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('messageStorage'); if (s) return s; console.warn('[AgenticLoop] Service "messageStorage" not available, falling back to singleton'); }
    return MessageStorage;
  }
  private getVisionProxy() {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('visionProxy'); if (s) return s; console.warn('[AgenticLoop] Service "visionProxy" not available, falling back to singleton'); }
    return getVisionProxy();
  }
  private getSnapshotService(cwd?: string) {
    // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪或未注册时回退到单例（容错）
    if (this._ctx) { const s = this._ctx.get('snapshot'); if (s) return s; console.warn('[AgenticLoop] Service "snapshot" not available, falling back to singleton'); }
    return getSnapshotService(cwd || this.lastCwd || ".");
  }
  private getEventLog() {
  // P0-7.1: ctx 可用时优先 ctx.get()，服务未就绪时回退到单例（容错）
  if (this._ctx) { const s = this._ctx.get('eventLog'); if (s) return s; console.warn('[AgenticLoop] Service "eventLog" not available, falling back to singleton'); }
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
    this.executor = new StreamingToolExecutorImpl(config?.toolExecutor);
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
      totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
          console.log(`[AgenticLoop] Planned ${cleaned.length} steps:`, cleaned.map(s => s.title));
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
    this.state = this.createInitialState();
    this.currentSessionId = sessionId;

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

    // Clear any stale guidance from a previous run for this session
    this.guidanceQueue.expire(sessionId);
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
    await initDefaultPipeline({
      isPlanMode: () => this.config.collaborationMode === "plan",
      isSandboxEnabled: () => false, // P1-5 sandbox not yet at Rust level
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
    console.log(`[AgenticLoop] Plan ${this.activePlan.total ?? 0} steps:`, this.activePlan.plan?.map(s => s.title));

      // Main loop — DSH-aligned: no built-in turn budget, no token cap.
      // The loop runs until the model produces no tool calls (natural completion).
      // DSH's agent loop has NO token budget cap and NO iteration cap on the main
      // loop — it only stops on natural completion or user abort. We align with this.
      // Safety valves (checked at the top of each iteration):
      //   1. maxIterations (if > 0): hard cap, ONLY used by sub-agents to prevent recursive runaway
      //   2. consecutiveNoProgress: stop if model is stuck in a loop with no progress
      while (true) {
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
        try {
          const { listGoals } = await import("../goal/goal");
          const goals = listGoals(sessionId, "in_progress");
          const blockedGoals = listGoals(sessionId, "blocked");
          if ((goals.length > 0 || blockedGoals.length > 0) && this.state.iteration > 1) {
            // Inject goal status into the system prompt for LLM awareness
            const goalSummary = [...goals, ...blockedGoals].map(g =>
              `- [${g.status}] ${g.title}${g.successCriteria ? ` (criteria: ${g.successCriteria})` : ""}`
            ).join("\n");
            console.log(`[AgenticLoop] Active goals:\n${goalSummary}`);
          }
        } catch (err) {
          // Goal system not available — non-critical
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
        if (apiMessages.length > 0 && apiMessages[0].role === "system") {
          if (typeof apiMessages[0].content === "string") {
            apiMessages[0].content += deferredPrompt;
          }
        }
      }

      console.log(`[AgenticLoop] collaborationMode=${this.config.collaborationMode}, hasAttachment=${hasDocumentAttachment}, tools available: ${toolDefs.length}/${allToolDefs.length} (deferred: ${deferredHints.length})`, toolDefs.map(t => t.name));

      // B3: Inject pending skill prompts (from load_skill tool)
      const { consumePendingSkillPrompts, getLoadedSkillPrompts, tickSessionSkills } = await import("./tools/load-skill");
      const pendingSkillPrompt = consumePendingSkillPrompts(sessionId);
      if (pendingSkillPrompt) {
        // Append to the system message or first user message
        if (apiMessages.length > 0 && apiMessages[0].role === "system") {
          const sysMsg = apiMessages[0];
          if (typeof sysMsg.content === "string") {
            sysMsg.content += pendingSkillPrompt;
          }
        }
        console.log("[AgenticLoop] Injected skill prompt:", pendingSkillPrompt.length, "chars");
      }

      // Also inject already-loaded skill prompts (for context recovery after compaction)
      const activeSkillPrompt = getLoadedSkillPrompts(sessionId);
      if (activeSkillPrompt && !pendingSkillPrompt) {
        if (apiMessages.length > 0 && apiMessages[0].role === "system") {
          const sysMsg = apiMessages[0];
          if (typeof sysMsg.content === "string" && !sysMsg.content.includes("Active Skill Instructions")) {
            sysMsg.content += activeSkillPrompt;
          }
        }
      }

      // 差距 3: Catalog 每轮刷新 — digest 对比，变更才注入
      const { buildCatalogMessage } = await import("./tools/load-skill");
      const catalogMessage = await buildCatalogMessage(sessionId);
      if (catalogMessage) {
        if (apiMessages.length > 0 && apiMessages[0].role === "system") {
          const sysMsg = apiMessages[0];
          if (typeof sysMsg.content === "string") {
            sysMsg.content += "\n\n" + catalogMessage;
          }
        }
        console.log("[AgenticLoop] Injected skill catalog:", catalogMessage.length, "chars");
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
      const { buildTimeContext } = await import("./time-context");
      const timeContextMessage = buildTimeContext(sessionId, this.state.iteration, 1);
      if (timeContextMessage) {
        if (apiMessages.length > 0 && apiMessages[0].role === "system") {
          const sysMsg = apiMessages[0];
          if (typeof sysMsg.content === "string") {
            sysMsg.content += "\n\n" + timeContextMessage;
          }
        }
      }

      // R3-3.1: Surface notice — 让模型知道当前上下文窗口状态
      const { getSurfaceManager } = await import("./surface-manager");
      const surfaceNotice = getSurfaceManager().buildSurfaceNotice(sessionId);
      if (surfaceNotice && apiMessages.length > 0 && apiMessages[0].role === "system") {
        const sysMsg = apiMessages[0];
        if (typeof sysMsg.content === "string") {
          sysMsg.content += "\n" + surfaceNotice;
        }
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

      // Execute iteration - yields events directly for real-time streaming
      let iterationToolCalls = 0;
      let iterationHadText = false;
      const spawnTaskIds: string[] = [];

      // P0: Start file change tracking at iteration boundary (before tools)
      // P1: 检查 fileChangeTracker Provider 服务可用性（对标 DSH 模式）
      const trackerSvc = this.getFileChangeTrackerService();
      if (!trackerSvc) {
        console.warn('[AgenticLoop] Service "fileChangeTracker" not available from ctx, creating standalone instance');
      }
      this.fileChangeTracker = new FileChangeTracker(
        cwd, sessionId, assistantMsgId, this.state.iteration,
      );
      await this.fileChangeTracker.start();
      for await (const event of this.executeIteration(
        sessionId,
        assistantMsgId,
        messagesForIteration,
        toolDefs,
        cwd,
        systemPrompt,
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
      console.log(`[AgenticLoop] Iteration ${this.state.iteration} completed: ${iterationToolCalls} tool calls (effective: ${this.state.toolCallsInIteration}), ${this.state.consecutiveErrors} consecutive errors`);
      // Runaway detection: track whether this iteration made any progress.
      // Progress = text output OR at least one effective tool call.
      if (iterationHadText || this.state.toolCallsInIteration > 0) {
        this.state.consecutiveNoProgress = 0;
      } else {
        this.state.consecutiveNoProgress++;
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
        // No un-waited sub-agents — safe to stop
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
    console.log(
      `[AgenticLoop] Plan updated via update_plan (now ${result.items.length} steps):`,
      result.items.map((s) => s.title),
    );
    return { ok: true, message: result.message };
  }

  private async *executeIteration(
    sessionId: string,
    assistantMsgId: string,
    apiMessages: any[],
    toolDefs: ToolDefinition[],
    cwd: string,
    systemPrompt: string,
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

      // 计划上下文注入：让模型每轮看到"当前执行计划 + 进行到第几步"
      // （对标 dsh todo —— 模型需要知道剩余步骤才能在合适时机 update_plan）。
      // 无计划（纯问答）时为空串，不影响既有 prompt 缓存。
      const planContext = renderPlanSection(this.activePlan.plan, this.macroStep);
      const effectiveSystemPrompt = planContext
        ? `${systemPrompt}\n\n${planContext}`
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
        console.log(`[AgenticLoop] Request header changed: ${headerChange.reason} — prefix cache may miss`);
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
          console.log(`[AgenticLoop] Iteration ${this.state.iteration}: calling LLM (attempt ${retryCount + 1}/${maxRetries}), messages: ${apiMessages.length}, tools: ${toolDefs.length}`);
          yield { type: "llm_status", status: "connecting" };
          let firstEventReceived = false;

          for await (const event of this.provider.stream(request)) {
            if (!firstEventReceived) {
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
                    } catch (parseErr) {
                      console.error("[AgenticLoop] Failed to parse tool args:", (ended as any).rawArgs, parseErr);
                      // Fallback: try to extract path and content from partial JSON
                      const rawStr = (ended as any).rawArgs as string;
                      const pathMatch = rawStr.match(/"path"\s*:\s*"([^"]*)"/);
                      const contentMatch = rawStr.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                      if (pathMatch) {
                        ended.input = {
                          path: pathMatch[1],
                          content: contentMatch ? JSON.parse(`"${contentMatch[1]}"`) : "",
                        };
                      }
                    }
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
          success = true;
          console.log(`[AgenticLoop] Iteration ${this.state.iteration}: LLM stream ended. finishReason: ${finishReason}, toolCalls: ${currentToolCalls.length}, text length: ${currentText.length}`);
        } catch (retryError: any) {
          retryCount++;
          console.error(`[AgenticLoop] Iteration ${this.state.iteration}: LLM stream error (attempt ${retryCount}/${maxRetries}):`, retryError.name, retryError.message);
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

      if (error.message?.includes("prompt_too_long") || error.message?.includes("context_length_exceeded")) {
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
        return;
      }

      this.state.consecutiveErrors++;
      this.state.lastError = error.message;
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

    console.log(`[AgenticLoop] Single-response dedup: ${currentToolCalls.length} tool calls in this response: [${currentToolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.input?.task_id || tc.input?.path || "")})`).join(", ")}]`);
    for (const tc of currentToolCalls) {
      const isRead = tc.name === "read" || tc.name === "read_file";
      const filePath = tc.input?.path || tc.input?.file_path;
      if (isRead && filePath && typeof filePath === "string") {
        // 去重键必须包含 offset/limit：同 path 不同 range 是两次不同读取
        // （与 readCache 的 offset/limit 区分一致），否则模型先读全文再读
        // 特定片段时第二个 read 会被误判为重复而跳过。
        const readOffset = typeof tc.input?.offset === "number" ? tc.input.offset : 1;
        const readLimit = typeof tc.input?.limit === "number" ? tc.input.limit : 2000;
        const readKey = `${filePath}|${readOffset}|${readLimit}`;
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
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens },
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
      const toolCtx: ToolContext = {
        sessionId,
        messageId: assistantMsgId,
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

        // Auto-snapshot before destructive tools
        if (["write", "edit", "bash"].includes(name) && ctx.cwd) {
          await this.ensureSnapshot(ctx.cwd, ctx.sessionId);
          if ((name === "write" || name === "edit") && typeof args.path === "string" && this.currentSnapshotId) {
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
        if ((name === "read" || name === "read_file") && filePath && this.readCache.has(filePath)) {
          const cached = this.readCache.get(filePath)!;
          if (cached.offset === readOffset && cached.limit === readLimit) {
            console.log(`[AgenticLoop] Cache hit for read ${filePath} (offset=${readOffset}, limit=${readLimit}) — returning cached content`);
            cacheHitCount++;
            return {
              id: "",
              name,
              input: args,
              output: `[CACHE HIT] This file was already read earlier in this conversation. The content has not changed since then. Use the content below directly — do NOT call read again.\n\nFile: ${filePath}\n\n${cached.output}`,
              status: "completed" as const,
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
            };
          }
        }

        // S0-2: PreToolUse hooks are now handled by HookPreExecuteMiddleware
        // in the pipeline's pre-execute layer. Do NOT duplicate them here.
        const effectiveArgs = args;

        const result = await tool.execute(effectiveArgs, ctx);

        console.log(`[AgenticLoop] Tool executed: ${name}, path: ${effectiveArgs.path || effectiveArgs.command || "(none)"}, output length: ${result.output?.length || 0}`);

        // S0-2: PostToolUse hooks are now handled by HookPostExecuteMiddleware
        // in the pipeline's post-execute layer. Do NOT duplicate them here.

        // ===== Update state after tool execution =====
        // Record read content for future cache hits (with the range it was read with,
        // so a later read of a different range does not reuse it)
        if ((name === "read" || name === "read_file") && filePath && result.output) {
          this.readCache.set(filePath, { offset: readOffset, limit: readLimit, output: result.output });
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
        return { id: "", name, input: args, output: result.output, status: "completed" as const, metadata: result.metadata };
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
          console.warn(`[buildMessages] Stripped dangling tool_calls from assistant ${msg.id} (tool results were dropped by context selection)`);
        } else if (matched.length !== (msg as any).tool_calls.length) {
          // Partial results → keep only the fulfilled tool_calls so the API pairing is exact.
          valid.push({ ...msg, tool_calls: matched });
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
    if (valid.length > 0 && llmMessages.length > valid.length) {
      const dropped = llmMessages.filter((m: any) => !valid.includes(m));
      if (dropped.length > 0 && !valid.some((m: any) => isFoldMessage(m))) {
        const foldMsg = renderFoldSummary(foldStats(dropped), "zh");
        valid.unshift({ role: "user", content: foldMsg, id: `ctx-fold-${Date.now()}` } as any);
      }
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
        const { microCompact, isAlreadyMicroCompacted } = await import("./micro-compact");
        if (!isAlreadyMicroCompacted(valid)) {
          const microResult = microCompact(valid);
          if (microResult.compactedCount > 0) {
            finalMessages = microResult.messages;
            this.state.microCompactedThisRun = true;
          }
        }
      }
    }

    console.log(`[buildMessages] raw: ${messages.length}, llm: ${llmMessages.length}, selected: ${valid.length}, final: ${finalMessages.length}`);
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
   * Priority levels:
   *   4 (CRITICAL) — Compaction markers (summaries of past context)
   *   3 (HIGH)     — User messages (original intent must be preserved)
   *   2 (MEDIUM)   — Assistant messages with tool calls, recent tool results
   *   1 (LOW)      — Old tool results, old assistant text-only messages
   *
   * Selection strategy: greedy by priority, then by recency within each tier.
   * Large tool results are truncated if budget is tight.
   */
  private selectMessagesByPriority(messages: any[], maxTokens: number): any[] {
    if (messages.length === 0) return [];

    // Estimate tokens for each message with the shared estimator (CJK-aware).
    const tokens = messages.map((msg) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      return Math.max(1, Math.ceil(estimateTokens(content)));
    });

    const totalTokens = tokens.reduce((a, b) => a + b, 0);
    if (totalTokens <= maxTokens) return [...messages]; // Everything fits

    // Assign priorities
    const recencyThreshold = Math.floor(messages.length * 0.7);
    const priorities = messages.map((msg, i) => {
      const content = typeof msg.content === "string" ? msg.content : "";
      const isRecent = i >= recencyThreshold ? 1 : 0;

      // Compaction markers — CRITICAL
      if (msg.role === "user" && content.startsWith("[上下文已自动压缩]")) return 4;
      // User messages — HIGH
      if (msg.role === "user") return 3;
      // Assistant with tool calls — MEDIUM
      if (msg.role === "assistant" && (msg as any).tool_calls) return 2 + isRecent;
      // Tool results — LOW-MEDIUM
      if (msg.role === "tool") return 1 + isRecent;
      // Assistant text-only — LOW
      return 1 + isRecent;
    });

    // Greedy selection: keep by priority tier, most recent first within each tier
    const selected = new Set<number>();
    let usedTokens = 0;

    // Tier 1: CRITICAL + HIGH (always keep)
    for (let i = 0; i < messages.length; i++) {
      if (priorities[i] >= 3) {
        selected.add(i);
        usedTokens += tokens[i];
      }
    }

    // Tier 2: MEDIUM (most recent first)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (priorities[i] >= 2 && !selected.has(i)) {
        if (usedTokens + tokens[i] <= maxTokens) {
          selected.add(i);
          usedTokens += tokens[i];
        }
      }
    }

    // Tier 3: LOW (most recent first)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!selected.has(i)) {
        if (usedTokens + tokens[i] <= maxTokens) {
          selected.add(i);
          usedTokens += tokens[i];
        }
      }
    }

    // Build result preserving order, with truncation for oversized tool results
    const result: any[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (!selected.has(i)) continue;
      let msg = messages[i];
      // Truncate very large tool results if over 90% budget
      if (msg.role === "tool" && usedTokens > maxTokens * 0.9) {
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.length > 5000) {
          const truncated = content.substring(0, 2000) + "\n...(truncated for context budget)";
          usedTokens -= tokens[i];
          usedTokens += Math.max(1, Math.ceil(estimateTokens("x".repeat(2000))));
          msg = { ...msg, content: truncated };
        }
      }
      result.push(msg);
    }

    return result;
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
    const { acquireCompactionLock, releaseCompactionLock, isCompactionBoundarySafe } =
      await import("./compaction-control");
    if (!acquireCompactionLock(sessionId)) {
      console.log("[compactMessages] Compaction already in progress, skipping");
      return 0;
    }

    try {
      const result = await this.doCompactMessages(sessionId, isCompactionBoundarySafe);
      return result;
    } finally {
      releaseCompactionLock(sessionId);
    }
  }

  private async doCompactMessages(
    sessionId: string,
    isBoundarySafe: (events: any[], seq: number) => { safe: boolean; reason?: string },
  ): Promise<number> {
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
    let keepCount = maxKeepCount;

    // Scan backwards to find a safe boundary
    // An assistant message starts a new API round. We want to keep
    // complete rounds, so the boundary must be at or before an assistant message.
    if (keepCount < messages.length) {
      // Walk backwards from keepCount position, looking for an assistant message
      let boundary = messages.length - keepCount;
      // If the message at boundary is not an assistant message (it might be
      // a tool result mid-round), walk backwards to find the start of the round
      while (boundary > 0 && messages[boundary].role !== "assistant" &&
             messages[boundary].role !== "user") {
        boundary--;
      }
      // If we walked back to a user message, that's also a safe boundary
      keepCount = messages.length - boundary;
    }

    const messagesToKeep = messages.slice(-keepCount);
    const messagesToRemove = messages.slice(0, messages.length - keepCount);

    if (messagesToRemove.length === 0) return 0;

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

    // Check for existing compaction marker (cascading compaction)
    // The marker has role "user" and starts with "[上下文已自动压缩]"
    let existingSummary = "";
    const oldMarkerIdx = messagesToRemove.findIndex(
      (m: any) => m.role === "user" && (m.content || "").startsWith("[上下文已自动压缩]")
    );
    if (oldMarkerIdx >= 0) {
      existingSummary = messagesToRemove[oldMarkerIdx].content || "";
      console.log(`[compactMessages] Found existing compaction marker at index ${oldMarkerIdx}, will cascade`);
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
    const { setCompactionInProgress } = await import("../storage/database");
    const eventLog = this.getEventLog();
    const messageStorage = this.getMessageStorage();
    const removedIds = messagesToRemove.map((m: any) => m.id);
    const markerContent = `[上下文已自动压缩]\n\n${summary}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条（API-Round 边界对齐）。请基于以上摘要和后续消息继续工作。不要重复已摘要中记录为完成的工作。如需之前的文件内容或命令输出，请使用工具重新获取。`;
    const markerTs = messagesToKeep[0]?.timestamp ?? Date.now();
    const markerId = `compact-${Date.now()}`;
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
        if (content.startsWith("[上下文已自动压缩]")) {
          // Include existing summary as-is for cascading
          parts.push(`[已有摘要]\n${content}`);
        } else if (content.trim()) {
          parts.push(`用户: ${content.substring(0, 500)}`);
        }
      } else if (msg.role === "assistant") {
        const content = (msg.content || "").substring(0, 500);
        if (content.trim()) parts.push(`AI: ${content}`);
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const argsStr = tc.args ? JSON.stringify(tc.args).substring(0, 200) : "";
            const resultStr = tc.result ? (typeof tc.result === "string" ? tc.result.substring(0, 200) : "") : "";
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
    const maxConvLen = 12000;
    const truncatedConv = conversationText.length > maxConvLen
      ? conversationText.substring(0, maxConvLen) + "\n...(更多对话已截断)"
      : conversationText;

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
    const maxConvLen = 12000;
    const truncatedConv = conversationText.length > maxConvLen
      ? conversationText.substring(0, maxConvLen) + "\n...(更多对话已截断)"
      : conversationText;

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
      query_session_result: "查询会话结果", list_sessions: "查看会话列表",
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
