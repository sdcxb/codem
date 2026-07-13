import type { ToolCallResult, LLMMessage } from "../llm/types";

// ========== F2.5: Parameter Security Scanner ==========

/** Patterns that indicate sensitive data in tool parameters */
const SENSITIVE_PATTERNS = [
  /(?:sk-|pk-|Bearer\s+)[a-zA-Z0-9]{20,}/i,  // API keys
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,    // Passwords
  /(?:secret|token)\s*[:=]\s*\S+/i,           // Secrets/tokens
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i, // Private keys
  /[a-zA-Z0-9+/]{40,}={0,2}/,                   // Base64 blobs (potential credentials)
];

/**
 * F2.5: Scan tool parameters for sensitive data before execution.
 * Returns a warning message if sensitive data is detected, or null if clean.
 */
function scanParametersForSecrets(name: string, args: Record<string, unknown>): string | null {
  // Only scan write/bash tools — read-only tools can't exfiltrate
  if (!["write", "edit", "multi_edit", "bash"].includes(name)) return null;

  const argsStr = JSON.stringify(args);
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(argsStr)) {
      // Don't block — just warn the LLM via the result
      return `[Security Warning] The parameters for tool "${name}" contain what appears to be sensitive data (API key, password, or private key). Be careful not to expose secrets in files or commands. If this is intentional (e.g., writing a .env template), proceed. If not, review the parameters.`;
    }
  }
  return null;
}

// ========== Types ==========
export interface StreamingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "error";
  result?: ToolCallResult;
  error?: string;
  abortController?: AbortController;
}

export interface ToolExecutorConfig {
  maxConcurrent: number;
  concurrencySafeTools: string[];
  toolTimeout: number;
  abortSiblingsOnError: boolean;
}

const DEFAULT_CONFIG: ToolExecutorConfig = {
  maxConcurrent: 5,
  // E5: Extended concurrency-safe tools — all read-only tools can run in parallel
  concurrencySafeTools: ["read", "glob", "grep", "codebase_search", "file_search", "list_directory", "web_fetch"],
  toolTimeout: 60000, // 60 seconds for regular tools
  abortSiblingsOnError: false,
};

export type ToolExecutorEvent =
  | { type: "tool_start"; toolCall: StreamingToolCall }
  | { type: "tool_progress"; toolCallId: string; progress: string }
  | { type: "tool_complete"; toolCall: StreamingToolCall; result: ToolCallResult }
  | { type: "tool_error"; toolCall: StreamingToolCall; error: string }
  | { type: "batch_complete"; results: ToolCallResult[] };

export interface ToolExecutorContext {
  sessionId: string;
  messageId: string;
  cwd: string;
  messages: LLMMessage[];
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, any> }): void;
}

// ========== Streaming Tool Executor ==========
export class StreamingToolExecutorImpl {
  private config: ToolExecutorConfig;
  private running: Map<string, StreamingToolCall> = new Map();

  constructor(config?: Partial<ToolExecutorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async *execute(
    toolCalls: StreamingToolCall[],
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
  ): AsyncGenerator<ToolExecutorEvent, ToolCallResult[], unknown> {
    const results: ToolCallResult[] = [];
    const concurrentBatch: StreamingToolCall[] = [];
    const sequentialQueue: StreamingToolCall[] = [];

    for (const tc of toolCalls) {
      if (this.config.concurrencySafeTools.includes(tc.name)) {
        concurrentBatch.push(tc);
      } else {
        sequentialQueue.push(tc);
      }
    }

    // Execute concurrent batch in parallel
    if (concurrentBatch.length > 0) {
      yield* this.executeBatch(concurrentBatch, ctx, toolHandler, results);
    }

    // Execute sequential tools one by one
    for (const tc of sequentialQueue) {
      yield* this.executeSingle(tc, ctx, toolHandler, results);
    }

    yield { type: "batch_complete", results };
    return results;
  }

  private async *executeBatch(
    toolCalls: StreamingToolCall[],
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
    results: ToolCallResult[],
  ): AsyncGenerator<ToolExecutorEvent, void, unknown> {
    const batches: StreamingToolCall[][] = [];
    for (let i = 0; i < toolCalls.length; i += this.config.maxConcurrent) {
      batches.push(toolCalls.slice(i, i + this.config.maxConcurrent));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (tc) => {
          tc.status = "running";
          tc.abortController = new AbortController();
          this.running.set(tc.id, tc);

          try {
            if (ctx.abort.aborted || tc.abortController.signal.aborted) {
              throw new Error("Aborted");
            }

            // F2.5: Security scan before execution
            const securityWarning = scanParametersForSecrets(tc.name, tc.input);

            // bash manages its own timeout via timeout_ms parameter; spawn/wait_subagent never timeout
            // write/edit/multi_edit may trigger user confirmation dialogs (overwrite, permission) — no timeout
            const noTimeoutTools = ["bash", "wait_for_subagent", "spawn_subagent", "write", "edit", "multi_edit"];
            const useTimeout = !noTimeoutTools.includes(tc.name);

            const result = await Promise.race([
              toolHandler(tc.name, tc.input, { ...ctx, abort: tc.abortController.signal }),
              useTimeout ? this.timeout(this.config.toolTimeout) : new Promise<never>(() => {}),
            ]);

            // F2.5: Append security warning to result if detected
            if (securityWarning && result.output) {
              result.output = `${securityWarning}\n\n${result.output}`;
            } else if (securityWarning) {
              (result as any).output = securityWarning;
            }

            tc.status = "completed";
            tc.result = result;
            results.push(result);

            return { type: "complete" as const, toolCall: tc, result };
          } catch (error: any) {
            tc.status = "error";
            tc.error = error.message;

            const errorResult: ToolCallResult = {
              id: tc.id,
              name: tc.name,
              input: tc.input,
              output: `Error: ${error.message}`,
              status: "error",
              error: error.message,
            };
            results.push(errorResult);

            return { type: "error" as const, toolCall: tc, error: error.message };
          } finally {
            this.running.delete(tc.id);
          }
        })
      );

      for (const item of batchResults) {
        if (item.type === "complete") {
          yield { type: "tool_start", toolCall: item.toolCall };
          yield { type: "tool_complete", toolCall: item.toolCall, result: item.result };
        } else {
          yield { type: "tool_start", toolCall: item.toolCall };
          yield { type: "tool_error", toolCall: item.toolCall, error: item.error };
        }
      }
    }
  }

  private async *executeSingle(
    tc: StreamingToolCall,
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
    results: ToolCallResult[],
  ): AsyncGenerator<ToolExecutorEvent, void, unknown> {
    yield { type: "tool_start", toolCall: tc };

    tc.status = "running";
    tc.abortController = new AbortController();
    this.running.set(tc.id, tc);

    try {
      if (ctx.abort.aborted || tc.abortController.signal.aborted) {
        throw new Error("Aborted");
      }

      // F2.5: Security scan before execution
      const securityWarning = scanParametersForSecrets(tc.name, tc.input);

      // bash manages its own timeout via timeout_ms parameter; spawn/wait_subagent never timeout
      // write/edit/multi_edit may trigger user confirmation dialogs — no timeout
      const noTimeoutTools = ["bash", "wait_for_subagent", "spawn_subagent", "write", "edit", "multi_edit"];
      const useTimeout = !noTimeoutTools.includes(tc.name);

      const result = await Promise.race([
        toolHandler(tc.name, tc.input, { ...ctx, abort: tc.abortController.signal }),
        useTimeout ? this.timeout(this.config.toolTimeout) : new Promise<never>(() => {}),
      ]);

      // F2.5: Append security warning to result if detected
      if (securityWarning && result.output) {
        result.output = `${securityWarning}\n\n${result.output}`;
      } else if (securityWarning) {
        (result as any).output = securityWarning;
      }

      tc.status = "completed";
      tc.result = result;
      results.push(result);

      yield { type: "tool_complete", toolCall: tc, result };
    } catch (error: any) {
      tc.status = "error";
      tc.error = error.message;

      const errorResult: ToolCallResult = {
        id: tc.id,
        name: tc.name,
        input: tc.input,
        output: `Error: ${error.message}`,
        status: "error",
        error: error.message,
      };
      results.push(errorResult);

      yield { type: "tool_error", toolCall: tc, error: error.message };
    } finally {
      this.running.delete(tc.id);
    }
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms`)), ms);
    });
  }

  abortAll() {
    for (const [, tc] of this.running) {
      if (tc.abortController) {
        tc.abortController.abort();
      }
    }
    this.running.clear();
  }

  getRunning(): StreamingToolCall[] {
    return Array.from(this.running.values());
  }

  updateConfig(config: Partial<ToolExecutorConfig>) {
    this.config = { ...this.config, ...config };
  }
}

let instance: StreamingToolExecutorImpl | null = null;

export function getStreamingToolExecutor(): StreamingToolExecutorImpl {
  if (!instance) {
    instance = new StreamingToolExecutorImpl();
  }
  return instance;
}
