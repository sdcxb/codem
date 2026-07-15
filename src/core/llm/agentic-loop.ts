import type { LLMProvider, LLMRequest, ToolDefinition, TokenUsage } from "./types";
import type { ToolRegistry, ToolContext, WriteConfirmResult } from "./tools";
import type { ToolExecutorConfig } from "./streaming-executor";
import { StreamingToolExecutorImpl, type StreamingToolCall } from "./streaming-executor";
import { RetryExecutor, classifyError, logRetry } from "../retry/retry";
import { getPermissionManager, type PermissionRequest, type PermissionResult } from "../permission/permission";
import { getSnapshotService } from "../snapshot/snapshot";
import * as MessageStorage from "../storage/message";
import { evaluateWithSecurityMode } from "../permission/security-mode";

// ========== Agentic Loop Types ==========
export type LoopResult =
  | { type: "stop"; reason: string; usage: TokenUsage }
  | { type: "overflow"; message: string; usage: TokenUsage }
  | { type: "aborted" }
  | { type: "error"; error: string };

export interface LoopState {
  iteration: number;
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
  /** E8: True if cost degradation has been activated (switched to cheaper model) */
  costDegraded: boolean;
  /** S4: True if a write confirmation was rejected by the user — stops the loop to prevent retries */
  writeRejected: boolean;
}

export interface LoopConfig {
  maxIterations: number;
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
}

const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 20,
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

export interface StepPlan {
  title: string;
}

export type LLMStatus = "connecting" | "streaming" | "executing_tools";

export type LoopEvent =
  | { type: "start"; iteration: number }
  | { type: "llm_status"; status: LLMStatus }
  | { type: "step_progress"; step: number; total: number | null; title: string; steps: StepPlan[] | null }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; toolCall: StreamingToolCall }
  | { type: "tool_complete"; toolCall: StreamingToolCall; result: any }
  | { type: "tool_error"; toolCall: StreamingToolCall; error: string }
  | { type: "permission_request"; request: PermissionRequest; resolve: (result: PermissionResult) => void }
  | { type: "compaction_start" }
  | { type: "compaction_end"; messagesRemoved: number }
  | { type: "retry"; attempt: number; delay: number; error: string; errorType: string | null }
  | { type: "usage"; usage: TokenUsage }
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
  private readCache: Map<string, string> = new Map();   // path → last read content
  private writeCache: Map<string, string> = new Map();  // path → last written content
  // Tracks subagent task IDs that have already been waited on in this run().
  // Prevents the LLM from repeatedly calling wait_for_subagent for the same
  // completed task across iterations (root cause of the "infinite wait" loop).
  private waitedSubagents: Map<string, string> = new Map(); // taskId → cached result output
  // Tracks subagent task IDs that have been spawned but NOT yet waited on.
  // Prevents the LLM from spawning endless subagents without collecting results.
  private spawnedSubagents: Set<string> = new Set(); // taskId (not yet waited on)
  // Tracks which tool names have been called during this run().
  // Used by the task-completeness check to detect premature stopping
  // (e.g., user asked to "save as test3.txt" but no write tool was called).
  private toolsCalledInRun: Set<string> = new Set();

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

  constructor(
    provider: LLMProvider,
    tools: ToolRegistry,
    config?: Partial<LoopConfig>,
  ) {
    this.provider = provider;
    this.tools = tools;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    this.executor = new StreamingToolExecutorImpl(config?.toolExecutor);
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
      costDegraded: false,
      writeRejected: false,
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

    if (toolCount === 0) {
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
   * Returns an array of step titles, like Codex/Catpaw pre-planning.
   */
  private async planSteps(userMessage: string): Promise<StepPlan[] | null> {
    try {
      const lang = (await import("../i18n/lang")).getLang();
      const estPrompt = lang === "zh"
        ? `你是一个任务规划器。根据用户的任务，拆解为具体的执行步骤。每一步对应一次 agentic 迭代（包括文字回答和工具调用）。

规则：
- 纯文字回答（无工具调用）= 1 步
- 回答 + 写文件 = 2 步
- 读文件 + 编辑文件 + 验证 = 3 步
- 复杂的多文件重构 = 5-10 步
- 最多 20 步

用 JSON 数组格式回复，每个元素包含 title 字段（简短的中文步骤描述）。不要有其他解释。
例如：[{"title":"回答问题"},{"title":"写入文件"}]`
        : `You are a task planner. Break down the user's task into concrete execution steps. Each step corresponds to one agentic iteration (including text answers and tool calls).

Rules:
- Simple text answer with no tools = 1 step
- Answer + write file = 2 steps
- Read file + edit file + verify = 3 steps
- Complex multi-file refactoring = 5-10 steps
- Maximum 20 steps

Reply as a JSON array, each element has a "title" field (short step description). No other explanation.
Example: [{"title":"Answer the question"},{"title":"Write to file"}]`;

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
      let jsonStr = response.content.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();
      // Also try to find a JSON array directly
      const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrayMatch) jsonStr = arrayMatch[0];

      const steps = JSON.parse(jsonStr) as StepPlan[];
      if (Array.isArray(steps) && steps.length > 0) {
        const limited = steps.slice(0, 20);
        console.log(`[AgenticLoop] Planned ${limited.length} steps:`, limited.map(s => s.title));
        return limited;
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
    // 每次新对话重置快照状态，确保每次对话独立创建快照
    this.resetSnapshot();
    // Reset tool deduplication state — new user message = new task, previous
    // read/write caches are no longer relevant
    this.readCache.clear();
    this.writeCache.clear();
    this.waitedSubagents.clear();
    this.spawnedSubagents.clear();
    this.toolsCalledInRun.clear();
    this.taskReminderSent = false;
    console.log(`[AgenticLoop.run] sessionId: ${sessionId}, userMessage: ${userMessage.substring(0, 80)}...`);

    // User message is saved by App.tsx (main session) or already in DB (sub-agent)
    // Don't save here to avoid duplicates

    // Local assistant message ID for tracking
    let assistantMsgId = `msg-${Date.now() + 1}`;

    // Pre-plan: use lightweight heuristic estimation (no extra LLM call)
    // This avoids blocking the main loop and prevents WebSocket interference in CLI mode
    const planState = this.estimateSteps(userMessage);
    console.log(`[AgenticLoop] Estimated ${planState.total ?? 0} steps:`, planState.plan?.map(s => s.title));

    // Main loop
    while (this.state.iteration < this.state.maxIterations) {
      this.state.iteration++;
      this.state.toolCallsInIteration = 0;
      this.state.compactedThisIteration = false;

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
              try { this.config.onTurnComplete(this.state.totalUsage); } catch {}
            }
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

      // Dynamically adjust if we exceed the plan
      if (planState.total !== null && this.state.iteration > planState.total) {
        planState.total = this.state.iteration + 1;
        // Append a generic step to the plan
        if (planState.plan) {
          planState.plan.push({ title: `Step ${this.state.iteration}` });
        }
      }

      yield { type: "start", iteration: this.state.iteration };
      // Emit step progress — deterministic, based on iteration count
      const stepTitle = planState.plan && planState.plan[this.state.iteration - 1]
        ? planState.plan[this.state.iteration - 1].title
        : "";
      yield { type: "step_progress", step: this.state.iteration, total: planState.total, title: stepTitle, steps: planState.plan };

      if (this.abortController.signal.aborted) {
        return { type: "aborted" };
      }

      const apiMessages = this.buildMessages(sessionId);
      const toolDefs = this.tools.getDefinitions();
      console.log("[AgenticLoop] tools available:", toolDefs.length, toolDefs.map(t => t.name));

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
        // F1.2: Trigger memory extraction after compaction
        if (this.config.memoryEnabled && this.config.onCompactionComplete) {
          try { this.config.onCompactionComplete(); } catch {}
        }
        messagesForIteration = this.buildMessages(sessionId);
        this.state.compactedThisIteration = true;
        this.state.consecutiveCompactions++;
      } else {
        // Reset consecutive compactions if no compaction needed
        this.state.consecutiveCompactions = 0;
      }

      
      // Execute iteration - yields events directly for real-time streaming
      let iterationToolCalls = 0;
      const spawnTaskIds: string[] = [];
      for await (const event of this.executeIteration(
        sessionId,
        assistantMsgId,
        messagesForIteration,
        toolDefs,
        cwd,
        systemPrompt,
      )) {
        yield event;
        if (event.type === "tool_start") iterationToolCalls++;
        // Update step title when we see the first tool call in this iteration
        if (event.type === "tool_start" && iterationToolCalls === 1) {
          // Use planned title if available, fall back to tool name
          const plannedTitle = planState.plan && planState.plan[this.state.iteration - 1]
            ? planState.plan[this.state.iteration - 1].title
            : "";
          const toolTitle = plannedTitle || this.getToolTitle(event.toolCall.name);
          yield { type: "step_progress", step: this.state.iteration, total: planState.total, title: toolTitle, steps: planState.plan };
        }
        // Track spawn_subagent calls
        if (event.type === "tool_start" && event.toolCall?.name === "spawn_subagent") {
          // The task ID will be in the tool result, extract it later
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
          try { this.config.onTurnComplete(this.state.totalUsage); } catch {}
        }
        yield { type: "end", result };
        return result;
      }

      // Check if we should continue
      if (this.state.toolCallsInIteration === 0 && !this.state.compactedThisIteration) {
        // === Task-completeness check ===
        // Before stopping, check if the user's original request asked for
        // specific actions (write/save/create) that haven't been performed yet.
        // If so, inject a reminder and continue the loop instead of stopping.
        const taskCheck = this.checkTaskCompleteness(userMessage);
        if (taskCheck) {
          console.log(`[AgenticLoop] Task incomplete — injecting reminder: ${taskCheck.substring(0, 100)}...`);
          MessageStorage.createMessage({
            id: `task-reminder-${Date.now()}`,
            role: "user",
            content: taskCheck,
            timestamp: Date.now(),
            status: "done",
          }, sessionId);
          this.msgCache = null;
          // Continue the loop — don't stop
          continue;
        }
        // Sub-agent guard: before stopping, check if there are spawned sub-agents
        // that haven't been waited on yet. If so, inject a reminder instead of stopping.
        if (this.spawnedSubagents.size > 0) {
          const unwaitedIds = Array.from(this.spawnedSubagents);
          const taskList = unwaitedIds.map(id => `  - task_id: "${id}"`).join("\n");
          const reminder = `[SYSTEM REMINDER] You have ${unwaitedIds.length} sub-agent(s) that were spawned but NOT waited on. You MUST call wait_for_subagent for each task ID below to collect their results.\n\nUn-waited task IDs:\n${taskList}\n\nCall wait_for_subagent(task_id: "...") for EACH task ID above. Do NOT spawn new sub-agents. Do NOT finish without collecting results.`;
          // Inject the reminder as a user message so the LLM sees it
          MessageStorage.createMessage({
            id: `reminder-${Date.now()}`,
            role: "user",
            content: reminder,
            timestamp: Date.now(),
            status: "done",
          }, sessionId);
          // Invalidate message cache so the reminder is included
          this.msgCache = null;
          console.warn(`[AgenticLoop] ${unwaitedIds.length} un-waited sub-agent(s) — injected wait_for_subagent reminder instead of stopping. IDs: ${unwaitedIds.join(", ")}`);
          // Continue the loop — don't stop
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
          try { this.config.onTurnComplete(this.state.totalUsage); } catch {}
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
          try { this.config.onTurnComplete(this.state.totalUsage); } catch {}
        }
        yield { type: "end", result };
        return result;
      }

      // New assistant message for next iteration is handled by App.tsx
      assistantMsgId = `msg-${Date.now() + this.state.iteration + 100}`;
    }

    const result: LoopResult = {
      type: "stop",
      reason: "max_iterations",
      usage: this.state.totalUsage,
    };
    // F1.3: Trigger memory extraction on max iterations stop
    if (this.config.memoryEnabled && this.config.onTurnComplete) {
      try { this.config.onTurnComplete(this.state.totalUsage); } catch {}
    }
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
      read_file: "Reading file",
      write_file: "Writing file",
      edit_file: "Editing file",
      multi_edit_file: "Editing file",
      list_directory: "Listing directory",
      search_code: "Searching code",
      grep_search: "Searching code",
      run_terminal_command: "Running command",
      run_test: "Running tests",
      web_fetch: "Fetching web",
      spawn_subagent: "Spawning sub-agent",
      create_file: "Creating file",
      delete_file: "Deleting file",
      file_search: "Searching files",
      todo_write: "Updating tasks",
      codebase_search: "Searching codebase",
    };
    return titleMap[toolName] || toolName;
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
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      const request: LLMRequest = {
        model: this.config.model || this.provider.id,
        messages: [
          { id: "system", role: "system", content: systemPrompt },
          ...apiMessages,
        ],
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        temperature: this.config.temperature,
        stream: true,
        abortSignal: this.abortController!.signal,
        // E2: Pass reasoning effort to LLM
        reasoningEffort: this.config.reasoningEffort,
      };

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
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        return;
      }

      if (error.message?.includes("prompt_too_long") || error.message?.includes("context_length_exceeded")) {
        if (this.config.enableReactiveCompaction) {
          yield { type: "compaction_start" };
          const compacted = await this.compactMessages(sessionId);
          yield { type: "compaction_end", messagesRemoved: compacted };
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
      return;
    }

    // Text content is handled by App.tsx via text_delta events
    // No need to write to database here

    // ===== Single-response deduplication =====
    // Remove duplicate read calls and duplicate wait_for_subagent calls within one response
    const seenReadPaths = new Set<string>();
    const seenWaitTaskIds = new Set<string>();
    const dedupedToolCalls: typeof currentToolCalls = [];
    const duplicateToolCalls: typeof currentToolCalls = [];
    console.log(`[AgenticLoop] Single-response dedup: ${currentToolCalls.length} tool calls in this response: [${currentToolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.input?.task_id || tc.input?.path || "")})`).join(", ")}]`);
    for (const tc of currentToolCalls) {
      const isRead = tc.name === "read" || tc.name === "read_file";
      const filePath = tc.input?.path || tc.input?.file_path;
      if (isRead && filePath && typeof filePath === "string") {
        if (seenReadPaths.has(filePath)) {
          duplicateToolCalls.push(tc);
          continue;
        }
        seenReadPaths.add(filePath);
      }
      // Deduplicate wait_for_subagent with the same task_id
      if (tc.name === "wait_for_subagent") {
        const taskId = tc.input?.task_id as string;
        // Within-response dedup: same task_id called multiple times in one response
        if (taskId && seenWaitTaskIds.has(taskId)) {
          duplicateToolCalls.push(tc);
          continue;
        }
        // Cross-iteration dedup: task_id already collected in a previous iteration.
        // This prevents the LLM from re-waiting on completed sub-agents across
        // iterations, which was the root cause of the "infinite wait" loop.
        if (taskId && this.waitedSubagents.has(taskId)) {
          console.warn(`[AgenticLoop] Single-response dedup: wait_for_subagent(${taskId}) already collected in previous iteration — skipping`);
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
        const isCrossIterWait = dtc.name === "wait_for_subagent" &&
          this.waitedSubagents.has(dtc.input?.task_id as string);
        yield {
          type: "tool_error",
          toolCall: dtc,
          error: isCrossIterWait
            ? `Skipped: wait_for_subagent for this task was already called in a previous iteration. The result was already collected. Do NOT call wait_for_subagent for this task again. Proceed to the next step (e.g., write the output file).`
            : "Skipped: Duplicate tool call in one response. This was automatically filtered out to prevent redundant operations.",
        };
      }
      currentToolCalls = dedupedToolCalls;
    }

    // Update usage
    this.state.totalUsage.promptTokens += usage.promptTokens;
    this.state.totalUsage.completionTokens += usage.completionTokens;
    this.state.totalUsage.totalTokens = this.state.totalUsage.promptTokens + this.state.totalUsage.completionTokens;
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
      abort: this.abortController!.signal,
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
    };

    for await (const event of this.executor.execute(
      currentToolCalls,
      toolCtx,
      async (name, args, ctx) => {
        const tool = this.tools.get(name);
        if (!tool) {
          return { id: "", name, input: args, output: `Tool "${name}" not found`, status: "error" as const };
        }

        // C1: Plan mode — block write tools
        if (this.config.collaborationMode === "plan") {
          const writeTools = ["write", "edit", "delete", "create_file", "delete_file"];
          if (writeTools.includes(name)) {
            return {
              id: "",
              name,
              input: args,
              output: `Blocked: Cannot use "${name}" in Plan mode. Plan mode is read-only. Ask the user to switch to Default mode to execute changes.`,
              status: "error" as const,
            };
          }
        }

        // Permission check — gated by security mode
        const secMode = this.config.securityMode || "ask";
        if (secMode !== "full" && this.config.enablePermissions) {
          const resource = typeof args.path === "string" ? args.path
            : typeof args.command === "string" ? args.command
            : undefined;
          const permissionManager = getPermissionManager();
          const rawAction = permissionManager.getEvaluator().evaluate(name, resource);

          // Apply security mode to the evaluated action
          const action = evaluateWithSecurityMode(secMode, name, resource, rawAction);

          if (action === "ask" && this.config.onPermissionRequest) {
            const requestId = `perm-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            const request: PermissionRequest = {
              id: requestId,
              sessionId: ctx.sessionId,
              tool: name,
              input: args,
              resource,
              timestamp: Date.now(),
            };

            const result = await this.config.onPermissionRequest(request);

            if (result.action === "deny") {
              return {
                id: "",
                name,
                input: args,
                output: `Permission denied by user for tool "${name}"`,
                status: "error" as const,
              };
            }
          } else if (action === "deny") {
            return {
              id: "",
              name,
              input: args,
              output: `Permission denied by policy for tool "${name}"`,
              status: "error" as const,
            };
          }
        }

        // Auto-snapshot before destructive tools
        if (["write", "edit", "bash"].includes(name) && ctx.cwd) {
          await this.ensureSnapshot(ctx.cwd, ctx.sessionId);
          if ((name === "write" || name === "edit") && typeof args.path === "string" && this.currentSnapshotId) {
            try {
              const { readFile } = await import("../file-api");
              const snapshotService = getSnapshotService(ctx.cwd);
              let content = "";
              let isNew = false;
              try {
                content = await readFile(args.path);
              } catch {
                // File doesn't exist yet (new file) — mark as new
                isNew = true;
              }
              await snapshotService.recordFile(this.currentSnapshotId, args.path, content, isNew);
            } catch {}
          }
        }

        // ===== State-based deduplication =====
        // Instead of counting loops and breaking, we intercept redundant operations
        // and return cached results with clear guidance to the LLM.
        const filePath = typeof args.path === "string" ? args.path : "";

        // READ: if this file was already read in this request and hasn't been written since,
        // return cached content instead of re-reading
        if ((name === "read" || name === "read_file") && filePath && this.readCache.has(filePath)) {
          const cached = this.readCache.get(filePath)!;
          console.log(`[AgenticLoop] Cache hit for read ${filePath} — returning cached content`);
          cacheHitCount++;
          return {
            id: "",
            name,
            input: args,
            output: `[CACHE HIT] This file was already read earlier in this conversation. The content has not changed since then. Use the content below directly — do NOT call read again.\n\nFile: ${filePath}\n\n${cached}`,
            status: "completed" as const,
          };
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

        // WAIT_FOR_SUBAGENT: if this task was already waited on in a previous iteration,
        // return the cached result and tell the LLM to stop calling wait_for_subagent for it.
        // This prevents the "infinite wait" loop where the LLM repeatedly calls
        // wait_for_subagent for already-completed tasks across iterations.
        if (name === "wait_for_subagent") {
          const taskId = typeof args.task_id === "string" ? args.task_id : "";
          console.log(`[AgenticLoop] wait_for_subagent called: task_id="${taskId}", args=${JSON.stringify(args).substring(0, 200)}`);
          if (!taskId) {
            console.warn(`[AgenticLoop] wait_for_subagent called WITHOUT task_id! Full args:`, JSON.stringify(args));
          }
          if (taskId && this.waitedSubagents.has(taskId)) {
            const cachedResult = this.waitedSubagents.get(taskId)!;
            console.warn(`[AgenticLoop] wait_for_subagent(${taskId}) CACHE HIT — already collected in iteration ${this.state.iteration}`);
            cacheHitCount++;
            return {
              id: "",
              name,
              input: args,
              output: `[ALREADY COLLECTED] You already called wait_for_subagent for task ${taskId} in a previous iteration and received the result. Do NOT call wait_for_subagent for this task again. Use the result you already received. Here is the cached result for reference:\n\n${cachedResult}\n\nIf you have collected all sub-agent results, proceed to the next step (e.g., write the output file). Do NOT wait again.`,
              status: "completed" as const,
            };
          }
        }

        const result = await tool.execute(args, ctx);

        // Track which tools have been called in this run() for task-completeness check
        this.toolsCalledInRun.add(name);
        console.log(`[AgenticLoop] Tool executed: ${name}, path: ${args.path || args.command || "(none)"}, output length: ${result.output?.length || 0}`);

        // ===== Update state after tool execution =====
        // Record read content for future cache hits
        if ((name === "read" || name === "read_file") && filePath && result.output) {
          this.readCache.set(filePath, result.output);
        }
        // Record written content and invalidate read cache for that file
        if ((name === "write" || name === "edit" || name === "multi_edit") && filePath &&
            result.output && result.output.includes("Successfully")) {
          if (name === "write" && typeof args.content === "string") {
            this.writeCache.set(filePath, args.content);
          } else {
            // For edit/multi_edit, we don't know the full final content, so just invalidate
            this.writeCache.delete(filePath);
          }
          // File changed — read cache is stale
          this.readCache.delete(filePath);
        }

        // Track waited subagent results for cross-iteration deduplication
        if (name === "wait_for_subagent" && result.output) {
          const taskId = typeof args.task_id === "string" ? args.task_id : "";
          if (taskId) {
            this.waitedSubagents.set(taskId, result.output);
            this.spawnedSubagents.delete(taskId); // Mark as waited on
          }
        }
        // Track spawned subagent task IDs to prevent endless spawning
        if (name === "spawn_subagent" && result.output) {
          // Extract task ID from the output (format: SUBAGENT_TASK_ID:sub-xxx)
          const match = result.output.match(/SUBAGENT_TASK_ID:(sub-[^\s\n]+)/);
          if (match && match[1]) {
            this.spawnedSubagents.add(match[1]);
            console.log(`[AgenticLoop] Tracked spawned subagent: ${match[1]} (total un-waited: ${this.spawnedSubagents.size})`);
          }
        }

        // S4: Detect write rejection — set flag to stop the loop
        if (result.output && result.output.includes("User rejected the overwrite")) {
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
        return { id: "", name, input: args, output: result.output, status: "completed" as const };
      },
    )) {
      switch (event.type) {
        case "tool_start":
          // Skip — already yielded during streaming phase to preserve LLM output order
          break;

        case "tool_complete":
          // Just yield - App.tsx handles persistence via useAppStore
          yield event;
          this.state.consecutiveErrors = 0;
          break;

        case "tool_error":
          // Just yield - App.tsx handles persistence via useAppStore
          yield event;
          this.state.consecutiveErrors++;
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
  private buildMessages(sessionId: string): any[] {
    const messages = MessageStorage.listMessages(sessionId);

    // --- E3: Incremental message building ---
    // Fingerprint MUST include tool call statuses + result presence, because
    // tool calls transition from "running" → "done" without changing message count,
    // content length, or toolCalls.length. Without this, the cache returns stale
    // messages where tool results are missing, causing the LLM to retry tool calls.
    const lastRaw = messages[messages.length - 1];
    const toolCallSig = lastRaw?.toolCalls
      ? lastRaw.toolCalls.map(tc => `${tc.status}:${tc.result ? '1' : '0'}`).join(',')
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
    const selected = this.selectMessagesByPriority(llmMessages, 100000);

    // Filter orphan tool messages AND strip dangling tool_calls
    // 1. If a "tool" message has no preceding assistant with tool_calls → drop it
    // 2. If an assistant has tool_calls but its tool results were dropped by selection
    //    → strip tool_calls from the assistant so the LLM doesn't see "pending" tool calls
    //    and retry them (root cause of tool call loops)
    const valid: any[] = [];
    let hasTools = false;
    for (const msg of selected) {
      if (msg.role === "assistant") {
        hasTools = !!(msg as any).tool_calls;
        valid.push(msg);
      } else if (msg.role === "tool") {
        if (hasTools) valid.push(msg);
      } else {
        hasTools = false;
        valid.push(msg);
      }
    }

    // Second pass: if an assistant has tool_calls but no following tool results,
    // strip the tool_calls to prevent the LLM from seeing incomplete tool calls
    for (let i = 0; i < valid.length; i++) {
      const msg = valid[i];
      if (msg.role === "assistant" && (msg as any).tool_calls) {
        // Check if the next messages are tool results for this assistant
        let hasResults = false;
        for (let j = i + 1; j < valid.length; j++) {
          if (valid[j].role === "tool") { hasResults = true; break; }
          if (valid[j].role === "assistant" || valid[j].role === "user") break;
        }
        if (!hasResults) {
          // Strip tool_calls — the LLM will only see the text content
          const { tool_calls, ...rest } = msg;
          valid[i] = rest;
          console.warn(`[buildMessages] Stripped dangling tool_calls from assistant ${msg.id} (tool results were dropped by context selection)`);
        }
      }
    }

    console.log(`[buildMessages] raw: ${messages.length}, llm: ${llmMessages.length}, selected: ${valid.length}`);
    // Diagnostic: dump the messages that will be sent to the LLM
    for (const m of valid) {
      if (m.role === "tool") {
        console.log(`  [buildMessages] tool result: toolCallId=${m.toolCallId}, content_len=${(m.content || "").length}, preview=${(m.content || "").substring(0, 120)}`);
      } else if (m.role === "assistant" && m.tool_calls) {
        console.log(`  [buildMessages] assistant ${m.id}: tool_calls=[${m.tool_calls.map((tc: any) => tc.function?.name).join(",")}], content_len=${(m.content || "").length}`);
      } else if (m.role === "user") {
        console.log(`  [buildMessages] user ${m.id}: content_len=${(m.content || "").length}, preview=${(m.content || "").substring(0, 80)}`);
      }
    }
    return valid;
  }

  /** Convert raw DB messages to LLM API format, stripping system-reminder tags and stale custom instructions */
  private convertMessagesToLLM(messages: any[]): any[] {
    const llmMessages = MessageStorage.messagesToLLMMessages(messages);
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

    // Estimate tokens for each message
    const tokens = messages.map((msg) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      return Math.ceil(content.length / 4);
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
          usedTokens += Math.ceil(2000 / 4);
          msg = { ...msg, content: truncated };
        }
      }
      result.push(msg);
    }

    return result;
  }

  private estimateContextPressure(messages: any[]): number {
    const totalChars = messages.reduce((sum, m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    const estimatedTokens = totalChars / 4;
    const maxTokens = 128000;
    return Math.min(1, estimatedTokens / maxTokens);
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
    const messages = MessageStorage.listMessages(sessionId);
    if (messages.length <= 2) return 0;

    // Keep the last N messages
    const keepCount = Math.min(20, messages.length);
    const messagesToKeep = messages.slice(-keepCount);
    const messagesToRemove = messages.slice(0, messages.length - keepCount);

    if (messagesToRemove.length === 0) return 0;

    // Check for existing compaction marker (cascading compaction)
    // The marker has role "user" and starts with "[上下文已自动压缩]"
    let existingSummary = "";
    const oldMarkerIdx = messagesToRemove.findIndex(
      m => m.role === "user" && (m.content || "").startsWith("[上下文已自动压缩]")
    );
    if (oldMarkerIdx >= 0) {
      existingSummary = messagesToRemove[oldMarkerIdx].content || "";
      console.log(`[compactMessages] Found existing compaction marker at index ${oldMarkerIdx}, will cascade`);
    }

    // Build conversation text for the LLM to summarize
    const conversationText = this.buildConversationText(messagesToRemove);

    // Generate LLM-powered summary
    let summary: string;
    try {
      summary = await this.generateCompactionSummary(conversationText, existingSummary);
    } catch (err) {
      console.warn("[compactMessages] LLM summary failed, falling back to snippet extraction:", err);
      summary = this.fallbackSummary(messagesToRemove);
    }

    // Delete old messages from the database (including old marker)
    const removedIds = messagesToRemove.map(m => m.id);
    MessageStorage.deleteMessagesByIds(removedIds);

    // Insert new compaction marker
    const markerContent = `[上下文已自动压缩]\n\n${summary}\n\n---\n已移除 ${messagesToRemove.length} 条旧消息，保留最近 ${keepCount} 条。请基于以上摘要和后续消息继续工作。不要重复已摘要中记录为完成的工作。`;

    const markerTs = messagesToKeep[0]?.timestamp ?? Date.now();
    MessageStorage.createMessage({
      id: `compact-${Date.now()}`,
      role: "user",
      content: markerContent,
      timestamp: markerTs - 1,
      status: "done",
    }, sessionId);

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
      const snapshotService = getSnapshotService(cwd);
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

  abort() {
    this.abortController?.abort();
    this.executor.abortAll();
  }

  /**
   * Task-completeness check: examines the user's original request to detect
   * required actions that haven't been performed yet.
   *
   * Returns a reminder string if the task is incomplete, or null if it's safe
   * to stop.
   *
   * This is NOT time-based — it's a deterministic state check:
   * - Did the user ask to "save/write/create" a file? → check if write was called
   * - Did the user ask to "use subagents"? → check if spawn_subagent was called
   * - Did the user ask to "summarize/combine"? → check if write was called (output)
   *
   * Only triggers ONCE per run() to avoid infinite reminders.
   */
  private taskReminderSent = false;

  private checkTaskCompleteness(userMessage: string): string | null {
    if (this.taskReminderSent) return null;

    const msg = userMessage.toLowerCase();
    const zh = /[\u4e00-\u9fa5]/.test(userMessage);
    const missing: string[] = [];

    // Check: user asked to save/write/create/append a file, but no write tool was called
    const asksToWrite =
      /save|write|create|保存|写入|创建|生成|另存|追加|输出到|写到/.test(msg) &&
      /\.(txt|md|json|js|ts|py|rs|csv|xml|html|css|yaml|yml|toml)/.test(msg);
    const hasWritten = this.toolsCalledInRun.has("write") ||
      this.toolsCalledInRun.has("edit") ||
      this.toolsCalledInRun.has("multi_edit");

    if (asksToWrite && !hasWritten) {
      // Try to extract the target filename from the user message
      const fileMatch = userMessage.match(/(\w+\.\w+)/g);
      const fileName = fileMatch && fileMatch.length > 0
        ? fileMatch[fileMatch.length - 1]  // Last filename mentioned is likely the output
        : null;
      missing.push(zh
        ? `你还没有执行写入操作。用户要求保存文件${fileName ? ` "${fileName}"` : ""}，但你没有调用 write 工具。请立即使用 write 工具完成写入。`
        : `You haven't performed a write operation. The user asked to save${fileName ? ` "${fileName}"` : ""}, but you didn't call the write tool. Please use the write tool now to complete the task.`
      );
    }

    // Check: user asked to use subagents, but none were spawned
    const asksForSubagent =
      /子智能体|子代理|sub.?agent|subagent|分别用/.test(msg);
    const hasSpawned = this.toolsCalledInRun.has("spawn_subagent");

    if (asksForSubagent && !hasSpawned) {
      missing.push(zh
        ? `用户要求使用子智能体来完成任务，但你没有调用 spawn_subagent 工具。请立即使用 spawn_subagent 工具派发子智能体。`
        : `The user asked to use sub-agents, but you didn't call spawn_subagent. Please use spawn_subagent now to delegate the work.`
      );
    }

    // Check: user asked to summarize/aggregate results, but no write was called
    // This catches cases like "汇总...追加到..." where the aggregation implies writing
    const asksToAggregate =
      /汇总|总结|合并|aggregate|summarize|combine/.test(msg);
    if (asksToAggregate && asksToWrite && !hasWritten) {
      // Already covered by asksToWrite check above, but add extra emphasis
      missing.push(zh
        ? `用户要求汇总子智能体的结果并写入文件，但你还没有执行写入操作。请立即使用 write 工具将汇总结果写入目标文件。`
        : `The user asked to aggregate sub-agent results and write to a file, but you haven't written yet. Please use the write tool now.`
      );
    }

    if (missing.length === 0) {
      return null;
    }

    // Mark as sent to prevent repeated reminders
    this.taskReminderSent = true;

    const header = zh
      ? `[任务未完成提醒] 你的回复中没有工具调用，但用户的原始请求尚未完成。以下是你遗漏的操作：`
      : `[TASK INCOMPLETE] Your response had no tool calls, but the user's original request is not yet complete. The following actions are missing:`;

    return `${header}\n\n${missing.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n${zh ? "请继续执行这些操作，不要只是回复文字就停止。" : "Please continue executing these actions. Do not stop with a text-only response."}`;
  }

  getState(): Readonly<LoopState> {
    return { ...this.state };
  }

  updateConfig(config: Partial<LoopConfig>) {
    this.config = { ...this.config, ...config };
  }
}
