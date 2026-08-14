import type { ToolCallResult, LLMMessage } from "../llm/types";
import { maybePersistToolResult, NEVER_PERSIST_TOOLS } from "./tool-result-storage";
import { getToolPipeline } from "./tool-pipeline";

// ========== P1-A: Per-message Tool Result Budget ==========

/**
 * Maximum aggregate size in chars for all tool_result blocks within a single
 * assistant response (one batch of parallel tool results). When exceeded,
 * the largest results are persisted to disk and replaced with previews
 * until under budget. Prevents N parallel tools from collectively producing
 * e.g. 10 × 40K = 400K in one turn's user message.
 */
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

// ========== P2-D: Error Message Smart Truncation ==========

/**
 * Truncate long error messages: keep head and tail, replace middle with
 * a truncation notice. Prevents long compilation errors / test outputs
 * from consuming excessive context tokens.
 */
const MAX_ERROR_MESSAGE_CHARS = 10_000;
const ERROR_HEAD_TAIL_CHARS = 5_000;

function truncateErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_CHARS) return message;
  const start = message.slice(0, ERROR_HEAD_TAIL_CHARS);
  const end = message.slice(-ERROR_HEAD_TAIL_CHARS);
  const truncated = message.length - MAX_ERROR_MESSAGE_CHARS;
  return `${start}\n\n... [${truncated} characters truncated] ...\n\n${end}`;
}

/**
 * After a batch of tool results is collected, check if their aggregate size
 * exceeds the per-message budget. If so, persist the largest results to disk
 * and replace with previews until under budget.
 */
async function enforcePerMessageBudget(
  results: ToolCallResult[],
  ctx: ToolExecutorContext,
): Promise<void> {
  let totalSize = results.reduce((sum, r) => sum + (r.output?.length || 0), 0);
  if (totalSize <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) return;

  // Sort by output size descending — persist largest first
  const sortable = results
    .filter(r => r.output && !NEVER_PERSIST_TOOLS.has(r.name))
    .sort((a, b) => (b.output?.length || 0) - (a.output?.length || 0));

  for (const r of sortable) {
    if (totalSize <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) break;
    if (!r.output) continue;
    const originalSize = r.output.length;
    const persistResult = await maybePersistToolResult(
      r.name, r.output, ctx.sessionId, ctx.cwd,
    );
    if (persistResult.persisted) {
      const newSize = persistResult.output.length;
      totalSize -= originalSize - newSize;
      r.output = persistResult.output;
    }
  }
}

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
  concurrencySafeTools: ["read", "glob", "grep", "codebase_search", "file_search", "list_directory", "web_fetch", "lsp"],
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
      // P-OPT2: Model-ordered result submission
      // Tools execute in parallel, but results are committed in model-order
      // to preserve prefix cache stability for the next LLM request.
      // We collect results into slots indexed by their position in the batch,
      // then yield them in original order once all complete.
      const slots: (ToolCallResult | { error: string; tc: StreamingToolCall })[] = new Array(batch.length);

      await Promise.all(
        batch.map(async (tc, idx) => {
          tc.status = "running";
          tc.abortController = new AbortController();
          this.running.set(tc.id, tc);

          try {
            if (ctx.abort?.aborted || tc.abortController.signal.aborted) {
              throw new Error("Aborted");
            }

            // F2.5: Security scan before execution
            const securityWarning = scanParametersForSecrets(tc.name, tc.input);

            // bash manages its own timeout via timeout_ms parameter; spawn/wait_subagent never timeout
            // write/edit/multi_edit may trigger user confirmation dialogs (overwrite, permission) — no timeout
            const noTimeoutTools = ["bash", "wait_for_subagent", "spawn_subagent", "write", "edit", "multi_edit"];
            const useTimeout = !noTimeoutTools.includes(tc.name);

            // P0-2: Route through ToolPipeline if initialized (5-layer waterfall)
            const pipeline = getToolPipeline();
            const pipelineResult = pipeline.execute(
              tc.name, tc.input, { ...ctx, abort: tc.abortController.signal }, toolHandler,
            );

            const result = await Promise.race([
              pipelineResult.then(pr => {
                // S0-1 fix: Pipeline catches tool exceptions internally and returns
                // status:"error" results. Re-throw to trigger catch block for
                // tool_error event emission, preserving the original error message.
                if (pr.result.status === "error") {
                  const errMsg = pr.result.error || pr.result.output || "Tool execution failed";
                  throw new Error(errMsg);
                }
                return pr.result;
              }),
              useTimeout ? this.timeout(this.config.toolTimeout) : new Promise<never>(() => {}),
            ]);

            // F2.5: Append security warning to result if detected
            if (securityWarning && result.output) {
              result.output = `${securityWarning}\n\n${result.output}`;
            } else if (securityWarning) {
              (result as any).output = securityWarning;
            }

            // P1-5: Persist large tool results to disk
            if (result.output && !NEVER_PERSIST_TOOLS.has(tc.name)) {
              const persistResult = await maybePersistToolResult(
                tc.name,
                result.output,
                ctx.sessionId,
                ctx.cwd,
              );
              if (persistResult.persisted) {
                result.output = persistResult.output;
              }
            }

            tc.status = "completed";
            tc.result = result;
            slots[idx] = result;

            return { type: "complete" as const, toolCall: tc, result };
          } catch (error: any) {
            tc.status = "error";
            tc.error = error.message;

            const errorResult: ToolCallResult = {
              id: tc.id,
              name: tc.name,
              input: tc.input,
              output: truncateErrorMessage(`Error: ${error.message}`),
              status: "error",
              error: error.message,
            };
            slots[idx] = { error: error.message, tc };

            return { type: "error" as const, toolCall: tc, error: error.message };
          } finally {
            this.running.delete(tc.id);
          }
        })
      );

      // P-OPT2: Yield results in model-order (batch array order)
      // This ensures the event log records tool results in the same
      // order the model emitted them, preserving prefix stability.
      for (let i = 0; i < batch.length; i++) {
        const slot = slots[i];
        const tc = batch[i];
        if (slot && "error" in slot && typeof slot.error === "string") {
          yield { type: "tool_start", toolCall: tc };
          yield { type: "tool_error", toolCall: tc, error: slot.error };
        } else if (slot) {
          yield { type: "tool_start", toolCall: tc };
          yield { type: "tool_complete", toolCall: tc, result: slot as ToolCallResult };
          results.push(slot as ToolCallResult);
        }
      }

      // P1-A: Enforce per-message tool result budget after each batch
      await enforcePerMessageBudget(results, ctx);
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
      if (ctx.abort?.aborted || tc.abortController.signal.aborted) {
        throw new Error("Aborted");
      }

      // F2.5: Security scan before execution
      const securityWarning = scanParametersForSecrets(tc.name, tc.input);

      // bash manages its own timeout via timeout_ms parameter; spawn/wait_subagent never timeout
      // write/edit/multi_edit may trigger user confirmation dialogs — no timeout
      const noTimeoutTools = ["bash", "wait_for_subagent", "spawn_subagent", "write", "edit", "multi_edit"];
      const useTimeout = !noTimeoutTools.includes(tc.name);

      // S0-1: Route through ToolPipeline (same as executeBatch) to ensure
      // all tools go through the 5-layer waterfall, including EventLog finalize.
      const pipeline = getToolPipeline();
      const pipelineResult = pipeline.execute(
        tc.name, tc.input, { ...ctx, abort: tc.abortController.signal }, toolHandler,
      );

      const result = await Promise.race([
        pipelineResult.then(pr => {
          // S0-1 fix: Pipeline catches tool exceptions internally and returns
          // status:"error" results. Re-throw to trigger catch block for
          // tool_error event emission, preserving the original error message.
          if (pr.result.status === "error") {
            const errMsg = pr.result.error || pr.result.output || "Tool execution failed";
            throw new Error(errMsg);
          }
          return pr.result;
        }),
        useTimeout ? this.timeout(this.config.toolTimeout) : new Promise<never>(() => {}),
      ]);

      // F2.5: Append security warning to result if detected
      if (securityWarning && result.output) {
        result.output = `${securityWarning}\n\n${result.output}`;
      } else if (securityWarning) {
        (result as any).output = securityWarning;
      }

      // P1-5: Persist large tool results to disk
      if (result.output && !NEVER_PERSIST_TOOLS.has(tc.name)) {
        const persistResult = await maybePersistToolResult(
          tc.name,
          result.output,
          ctx.sessionId,
          ctx.cwd,
        );
        if (persistResult.persisted) {
          result.output = persistResult.output;
        }
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
        output: truncateErrorMessage(`Error: ${error.message}`),
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
