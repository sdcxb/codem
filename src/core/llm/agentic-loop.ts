import type { LLMProvider, LLMRequest, ToolDefinition, TokenUsage } from "./types";
import type { ToolRegistry, ToolContext } from "./tools";
import type { ToolExecutorConfig } from "./streaming-executor";
import { StreamingToolExecutorImpl, type StreamingToolCall } from "./streaming-executor";
import { RetryExecutor, classifyError, logRetry } from "../retry/retry";
import { getPermissionManager, type PermissionRequest, type PermissionResult } from "../permission/permission";
import { getSnapshotService } from "../snapshot/snapshot";
import * as MessageStorage from "../storage/message";

// ========== Agentic Loop Types ==========
export type LoopResult =
  | { type: "stop"; reason: string; usage: TokenUsage }
  | { type: "overflow"; message: string }
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
};

export type LoopEvent =
  | { type: "start"; iteration: number }
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
  private provider: LLMProvider;
  private tools: ToolRegistry;
  private executor: StreamingToolExecutorImpl;
  private retryExecutor: RetryExecutor;
  private config: LoopConfig;
  private state: LoopState;
  private abortController: AbortController | null = null;
  private currentSnapshotId: string | null = null;
  private lastCwd: string = "";
  // Loop detection
  private recentTexts: string[] = [];
  private recentToolCalls: string[] = [];
  private readonly MAX_RECENT_TEXTS = 5;

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
    };
  }

  async *run(
    sessionId: string,
    userMessage: string,
    cwd: string,
    systemPrompt: string,
  ): AsyncGenerator<LoopEvent, LoopResult, unknown> {
    this.abortController = new AbortController();
    this.state = this.createInitialState();
    console.log(`[AgenticLoop.run] sessionId: ${sessionId}, userMessage: ${userMessage.substring(0, 50)}...`);

    // User message is saved by App.tsx (main session) or already in DB (sub-agent)
    // Don't save here to avoid duplicates

    // Local assistant message ID for tracking
    let assistantMsgId = `msg-${Date.now() + 1}`;
    

    // Main loop
    while (this.state.iteration < this.state.maxIterations) {
      this.state.iteration++;
      this.state.toolCallsInIteration = 0;

      
      yield { type: "start", iteration: this.state.iteration };

      if (this.abortController.signal.aborted) {
        return { type: "aborted" };
      }

      const apiMessages = this.buildMessages(sessionId);
      const toolDefs = this.tools.getDefinitions();
      console.log("[AgenticLoop] tools available:", toolDefs.length, toolDefs.map(t => t.name));

      this.state.contextPressure = this.estimateContextPressure(apiMessages);

      let messagesForIteration = apiMessages;
      if (this.state.contextPressure > this.config.compactionThreshold && this.config.enableCompaction) {
        yield { type: "compaction_start" };
        const compacted = this.compactMessages(sessionId);
        yield { type: "compaction_end", messagesRemoved: compacted };
        messagesForIteration = this.buildMessages(sessionId);
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
        // Track spawn_subagent calls
        if (event.type === "tool_start" && event.toolCall?.name === "spawn_subagent") {
          // The task ID will be in the tool result, extract it later
        }
      }
      this.state.toolCallsInIteration = iterationToolCalls;

      // Check if we should continue
      if (this.state.toolCallsInIteration === 0) {
        
        const result: LoopResult = {
          type: "stop",
          reason: "completed",
          usage: this.state.totalUsage,
        };
        yield { type: "end", result };
        return result;
      }

      if (this.state.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        const result: LoopResult = {
          type: "stop",
          reason: "too_many_errors",
          usage: this.state.totalUsage,
        };
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
    yield { type: "end", result };
    return result;
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
      };

      // Stream events directly - no collection, real-time yielding
      let retryCount = 0;
      const maxRetries = 3;
      let success = false;

      while (!success && retryCount < maxRetries) {
        try {
          for await (const event of this.provider.stream(request)) {
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
                yield { type: "tool_start", toolCall: tc };
                break;

              case "tool_use_delta":
                const existing = currentToolCalls.find((t) => t.id === event.id);
                if (existing) {
                  (existing as any).rawArgs = ((existing as any).rawArgs || "") + event.input;
                }
                break;

              case "tool_use_end":
                const ended = currentToolCalls.find((t) => t.id === event.id);
                if (ended && (ended as any).rawArgs) {
                  try {
                    ended.input = JSON.parse((ended as any).rawArgs);
                  } catch {}
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
        } catch (retryError: any) {
          retryCount++;
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
          const compacted = this.compactMessages(sessionId);
          yield { type: "compaction_end", messagesRemoved: compacted };
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

    // Loop detection: track recent text outputs
    if (currentText) {
      this.recentTexts.push(currentText.substring(0, 200));
      if (this.recentTexts.length > this.MAX_RECENT_TEXTS) {
        this.recentTexts.shift();
      }
      
      // Check for repeated patterns
      if (this.recentTexts.length >= 3) {
        const last = this.recentTexts[this.recentTexts.length - 1];
        const repeated = this.recentTexts.filter(t => t === last).length;
        if (repeated >= 3) {
          console.warn("[AgenticLoop] Detected loop pattern, breaking");
          yield { type: "text_delta", text: "\n\n[检测到重复循环，自动终止任务]" };
          return;
        }
      }
    }
    
    // Tool call loop detection: track recent tool calls
    if (currentToolCalls.length > 0) {
      const toolCallKey = currentToolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input)}`).join("|");
      this.recentToolCalls.push(toolCallKey);
      if (this.recentToolCalls.length > 10) {
        this.recentToolCalls.shift();
      }
      // Check if same tool call repeated 3+ times
      const repeatedTools = this.recentToolCalls.filter(t => t === toolCallKey).length;
      if (repeatedTools >= 3) {
        console.warn("[AgenticLoop] Detected tool call loop, breaking");
        yield { type: "text_delta", text: "\n\n[检测到工具调用重复循环，自动终止任务]" };
        return;
      }
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

    // Execute tools
    this.state.toolCallsInIteration = currentToolCalls.length;

    const toolCtx: ToolContext = {
      sessionId,
      messageId: assistantMsgId,
      cwd,
      abort: this.abortController!.signal,
      messages: this.buildMessages(sessionId),
      metadata: () => {},
    };

    for await (const event of this.executor.execute(
      currentToolCalls,
      toolCtx,
      async (name, args, ctx) => {
        const tool = this.tools.get(name);
        if (!tool) {
          return { id: "", name, input: args, output: `Tool "${name}" not found`, status: "error" as const };
        }

        // Permission check
        if (this.config.enablePermissions) {
          const resource = typeof args.path === "string" ? args.path
            : typeof args.command === "string" ? args.command
            : undefined;
          const permissionManager = getPermissionManager();
          const action = permissionManager.getEvaluator().evaluate(name, resource);

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
              const content = await readFile(args.path);
              await snapshotService.recordFile(this.currentSnapshotId, args.path, content);
            } catch {}
          }
        }

        const result = await tool.execute(args, ctx);
        return { id: "", name, input: args, output: result.output, status: "completed" as const };
      },
    )) {
      switch (event.type) {
        case "tool_start":
          // Just yield - App.tsx handles persistence via useAppStore
          yield event;
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
  }

  private buildMessages(sessionId: string): any[] {
    const messages = MessageStorage.listMessages(sessionId);
    const llmMessages = MessageStorage.messagesToLLMMessages(messages);
    
    // Filter out <system-reminder> tags from all messages
    for (const msg of llmMessages) {
      if (typeof msg.content === "string") {
        msg.content = msg.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      }
    }
    
    console.log(`[buildMessages] sessionId: ${sessionId}, raw messages: ${messages.length}, llm messages: ${llmMessages.length}`);
    if (llmMessages.length > 0) {
      console.log(`[buildMessages] first message: role=${llmMessages[0].role}, content=${(llmMessages[0].content as string)?.substring(0, 100)}`);
    }
    
    // Context-aware limiting: send as many messages as fit in ~100K tokens
    const maxTokens = 100000;
    let totalTokens = 0;
    const selected: typeof llmMessages = [];
    
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      const msg = llmMessages[i];
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      const msgTokens = Math.ceil(content.length / 4);
      
      if (totalTokens + msgTokens > maxTokens) break;
      
      selected.unshift(msg);
      totalTokens += msgTokens;
    }
    
    // Filter orphan tool messages
    const valid: typeof llmMessages = [];
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
    
    console.log(`[buildMessages] total: ${messages.length}, selected: ${valid.length}, tokens: ~${totalTokens}`);
    return valid;
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

  private compactMessages(sessionId: string): number {
    const messages = MessageStorage.listMessages(sessionId);
    const keepCount = Math.min(20, messages.length);
    return messages.length - keepCount;
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

  getState(): Readonly<LoopState> {
    return { ...this.state };
  }

  updateConfig(config: Partial<LoopConfig>) {
    this.config = { ...this.config, ...config };
  }
}
