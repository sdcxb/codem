import type { LLMProvider, LLMRequest, ToolDefinition, TokenUsage } from "./types";
import type { ToolRegistry, ToolContext } from "./tools";
import type { SessionManager, Session, MessageV2, Part } from "./session";
import type { ToolExecutorConfig } from "./streaming-executor";
import { StreamingToolExecutorImpl, type StreamingToolCall } from "./streaming-executor";
import { RetryExecutor, classifyError, logRetry } from "../retry/retry";
import { getPermissionManager, type PermissionRequest, type PermissionResult } from "../permission/permission";
import { getSnapshotService } from "../snapshot/snapshot";

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
  private sessions: SessionManager;
  private executor: StreamingToolExecutorImpl;
  private retryExecutor: RetryExecutor;
  private config: LoopConfig;
  private state: LoopState;
  private abortController: AbortController | null = null;
  private currentSnapshotId: string | null = null;
  private lastCwd: string = "";

  constructor(
    provider: LLMProvider,
    tools: ToolRegistry,
    sessions: SessionManager,
    config?: Partial<LoopConfig>,
  ) {
    this.provider = provider;
    this.tools = tools;
    this.sessions = sessions;
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

    const log = (msg: string) => {
      console.log(msg);
      try { (window as any).__TAURI__?.core.invoke("append_file", { path: "engine.log", content: `[${new Date().toISOString()}] ${msg}` }); } catch {}
    };

    log(`[AgenticLoop] run START, sessionId: ${sessionId}`);
    const session = this.sessions.getSession(sessionId);
    log(`[AgenticLoop] getSession: ${session ? "FOUND" : "NOT FOUND"}`);
    if (!session) {
      log(`[AgenticLoop] ERROR: Session not found, yielding error event`);
      yield { type: "end", result: { type: "error", error: "Session not found" } };
      return { type: "error", error: "Session not found" };
    }

    // Add user message
    const userMsg: MessageV2 = {
      id: `msg-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", content: userMessage }],
      timestamp: Date.now(),
    };
    this.sessions.addMessage(sessionId, userMsg);
    log(`[AgenticLoop] user message added`);

    // Create assistant message
    let assistantMsg: MessageV2 = {
      id: `msg-${Date.now() + 1}`,
      role: "assistant",
      parts: [],
      timestamp: Date.now(),
      model: this.provider.id,
    };
    this.sessions.addMessage(sessionId, assistantMsg);
    log(`[AgenticLoop] assistant message created, entering main loop`);

    // Main loop
    while (this.state.iteration < this.state.maxIterations) {
      this.state.iteration++;
      this.state.toolCallsInIteration = 0;

      log(`[AgenticLoop] iteration ${this.state.iteration}, building messages...`);
      yield { type: "start", iteration: this.state.iteration };

      if (this.abortController.signal.aborted) {
        return { type: "aborted" };
      }

      const apiMessages = this.buildMessages(session);
      const toolDefs = this.tools.getDefinitions();

      this.state.contextPressure = this.estimateContextPressure(apiMessages);

      let messagesForIteration = apiMessages;
      if (this.state.contextPressure > this.config.compactionThreshold && this.config.enableCompaction) {
        yield { type: "compaction_start" };
        const compacted = this.compactMessages(session.messages);
        this.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
          ...msg,
          parts: [{ type: "text", content: `[Context compacted]` } as Part],
        }));
        yield { type: "compaction_end", messagesRemoved: compacted };
        messagesForIteration = this.buildMessages(this.sessions.getSession(sessionId)!);
      }

      log(`[AgenticLoop] calling executeIteration...`);
      // Execute iteration and collect events
      const events = await this.executeIteration(
        sessionId,
        assistantMsg,
        messagesForIteration,
        toolDefs,
        cwd,
        systemPrompt,
      );
      log(`[AgenticLoop] executeIteration returned ${events.length} events, toolCalls: ${this.state.toolCallsInIteration}`);

      // Yield all collected events
      for (const event of events) {
        log(`[AgenticLoop] yielding event: ${event.type}`);
        yield event;
      }

      // Check if we should continue
      if (this.state.toolCallsInIteration === 0) {
        log(`[AgenticLoop] no tool calls, stopping`);
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

      // Create new assistant message for next iteration
      assistantMsg = {
        id: `msg-${Date.now() + this.state.iteration + 100}`,
        role: "assistant",
        parts: [],
        timestamp: Date.now(),
        model: this.provider.id,
      };
      this.sessions.addMessage(sessionId, assistantMsg);
    }

    const result: LoopResult = {
      type: "stop",
      reason: "max_iterations",
      usage: this.state.totalUsage,
    };
    yield { type: "end", result };
    return result;
  }

  private async executeIteration(
    sessionId: string,
    assistantMsg: MessageV2,
    apiMessages: any[],
    toolDefs: ToolDefinition[],
    cwd: string,
    systemPrompt: string,
  ): Promise<LoopEvent[]> {
    const events: LoopEvent[] = [];
    let currentText = "";
    let currentToolCalls: StreamingToolCall[] = [];
    let finishReason = "stop";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const log = (msg: string) => {
      console.log(msg);
      try { (window as any).__TAURI__?.core.invoke("append_file", { path: "engine.log", content: `[${new Date().toISOString()}] ${msg}` }); } catch {}
    };

    const session = this.sessions.getSession(sessionId);

    try {
      const request: LLMRequest = {
        model: this.config.model || this.provider.id,
        messages: [
          { id: "system", role: "system", content: systemPrompt },
          ...apiMessages,
        ],
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        temperature: this.config.temperature,
        maxTokens: this.config.maxOutputTokens,
        stream: true,
        abortSignal: this.abortController!.signal,
      };

      log(`[executeIteration] model: ${request.model}, msgs: ${request.messages.length}, tools: ${request.tools?.length || 0}`);
      log(`[executeIteration] provider: ${this.provider.id}, baseUrl: ${(this.provider as any).config?.baseUrl}`);

      // Execute with retry for transient errors
      await this.retryExecutor.execute(
        async () => {
          log(`[executeIteration] calling provider.stream...`);
          for await (const event of this.provider.stream(request)) {
            log(`[executeIteration] stream event: ${event.type}`);
            switch (event.type) {
              case "text_delta":
                currentText += event.text;
                events.push({ type: "text_delta", text: event.text });
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
                events.push({ type: "tool_start", toolCall: tc });
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
                if (event.usage) {
                  usage = event.usage;
                }
                break;

              case "end":
                finishReason = event.finishReason;
                break;

              case "error":
                events.push({ type: "tool_error", toolCall: { id: "", name: "", input: {}, status: "error" }, error: event.error });
                break;
            }
          }
        },
        (attempt, delay, error) => {
          const { type } = classifyError(error);
          logRetry(attempt, delay, error);
          events.push({
            type: "retry",
            attempt,
            delay,
            error: error instanceof Error ? error.message : String(error),
            errorType: type,
          });
        },
      );
    } catch (error: any) {
      if (error.name === "AbortError") {
        return events;
      }

      if (error.message?.includes("prompt_too_long") || error.message?.includes("context_length_exceeded")) {
        if (this.config.enableReactiveCompaction) {
          events.push({ type: "compaction_start" });
          const compacted = this.compactMessages(session?.messages || []);
          events.push({ type: "compaction_end", messagesRemoved: compacted });
        }
        return events;
      }

      this.state.consecutiveErrors++;
      this.state.lastError = error.message;
      events.push({ type: "tool_error", toolCall: { id: "", name: "", input: {}, status: "error" }, error: error.message });
      return events;
    }

    // Add text part
    if (currentText) {
      this.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
        ...msg,
        parts: [...msg.parts, { type: "text", content: currentText } as Part],
      }));
    }

    // Update usage
    this.state.totalUsage.promptTokens += usage.promptTokens;
    this.state.totalUsage.completionTokens += usage.completionTokens;
    this.state.totalUsage.totalTokens = this.state.totalUsage.promptTokens + this.state.totalUsage.completionTokens;
    events.push({ type: "usage", usage });

    // If no tool calls, we're done
    if (currentToolCalls.length === 0) {
      return events;
    }

    // Execute tools
    this.state.toolCallsInIteration = currentToolCalls.length;

    const toolCtx: ToolContext = {
      sessionId,
      messageId: assistantMsg.id,
      cwd,
      abort: this.abortController!.signal,
      messages: this.sessions.toAPIMessages(session?.messages || []),
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
          // Record file before modification (for write/edit)
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
          this.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
            ...msg,
            parts: [...msg.parts, {
              type: "tool",
              id: event.toolCall.id,
              name: event.toolCall.name,
              input: event.toolCall.input,
              status: "running",
            } as Part],
          }));
          break;

        case "tool_complete":
          this.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
            ...msg,
            parts: msg.parts.map((p) =>
              p.type === "tool" && p.id === event.toolCall.id
                ? { ...p, output: event.result.output, status: "completed" }
                : p
            ),
          }));

          this.sessions.addMessage(sessionId, {
            id: `msg-${Date.now()}-${event.toolCall.id}`,
            role: "user",
            parts: [{ type: "text", content: `[Tool Result]\n${event.result.output}` }],
            timestamp: Date.now(),
          });

          events.push({ type: "tool_complete", toolCall: event.toolCall, result: event.result });
          this.state.consecutiveErrors = 0;
          break;

        case "tool_error":
          this.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
            ...msg,
            parts: msg.parts.map((p) =>
              p.type === "tool" && p.id === event.toolCall.id
                ? { ...p, output: `Error: ${event.error}`, status: "error", error: event.error }
                : p
            ),
          }));

          events.push({ type: "tool_error", toolCall: event.toolCall, error: event.error });
          this.state.consecutiveErrors++;
          break;
      }
    }

    return events;
  }

  private buildMessages(session: Session): any[] {
    return this.sessions.toAPIMessages(session.messages);
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

  private compactMessages(messages: MessageV2[]): number {
    const keepCount = Math.min(20, messages.length);
    return messages.length - keepCount;
  }

  private async ensureSnapshot(cwd: string, sessionId: string): Promise<void> {
    // Create a new snapshot for each destructive tool batch
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
