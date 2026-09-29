import type { ToolCallResult, LLMMessage } from "../llm/types";
import { maybePersistToolResult, NEVER_PERSIST_TOOLS } from "./tool-result-storage";
import { getToolPipeline } from "./tool-pipeline";
import { DEFAULT_CONCURRENCY_SAFE_TOOLS } from "./concurrency-policy";

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
  /** 累积到的工具参数原文（用于解析失败时诊断/拒绝执行，第 66 波） */
  rawArgs?: string;
  /** 参数 JSON 解析失败的原因 —— 有它就必须**拒绝执行**（第 66 波） */
  argsError?: string;
  /** 参数原文长度（判断是否被输出上限截断） */
  argsRawLength?: number;
}

export interface ToolExecutorConfig {
  maxConcurrent: number;
  concurrencySafeTools: string[];
  toolTimeout: number;
  abortSiblingsOnError: boolean;
}

const DEFAULT_CONFIG: ToolExecutorConfig = {
  // 10 —— 与 DSH 基线的 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` 对齐
  // （zcode 的 `DEFAULT_MAX_CONCURRENCY` 也是 10）。
  //
  // 第 119 轮实测：本机 1469 条回复里，并发工具调用数中位数 1、p90 2、p99 3、
  // **最大 4**，从未超过 5。所以从 5 提到 10 在**历史分布**上不会触发任何变化 ——
  // 这次改的是「上限不再成为天花板」，真实吞吐提升来自同一轮把
  // 定长块换成 rolling pool（见 `executeBatch`）。
  maxConcurrent: 10,
  // 名单唯一定义在 concurrency-policy.ts。此前这里硬编码了 9 个名字，其中
  // codebase_search / file_search / list_directory / web_fetch / zvec_grep_search
  // 等 6 个**不对应任何真实工具**，而真实存在的 web_search 反而缺席、被强制串行。
  concurrencySafeTools: DEFAULT_CONCURRENCY_SAFE_TOOLS,
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
  /**
   * 当前这次工具调用的 id（provider 给的 `tool_calls[].id`，如 `call_00_DJaAV…`）。
   *
   * ## 为什么必须把它放进 ctx（第 71 轮真机实测才发现）
   *
   * 工具处理器（`agentic-loop.ts` 里那个 `async (name, args, ctx) => …`）返回的
   * `ToolCallResult.id` **一直是空串**（那些 `id: ""` 是字面量，全仓 6 处）。
   * 于是所有**在处理器之外**读取 `result.id` 的地方拿到的都是空：
   * - `EventLogFinalizeMiddleware` 写进事件日志的 `tool_call` / `tool_result` 事件
   *   **`toolCallId` 全是空串**（事件日志正是"执行轨迹/事后复盘"的数据源，
   *   空 id 等于这些记录没法回指到具体调用）；
   * - 溢出（spill）文件名变成 `bash--<毫秒>.txt`（真机实测到的就是这个名字）。
   *
   * 处理器签名 `(name, args, ctx)` 里本来就没有调用 id，所以这里按**每次调用**注入：
   * `executeBatch` / `executeSingle` 调管线时传 `toolCallId: tc.id`。
   * 读取方一律用 `result.id || ctx.toolCallId`（前者优先：将来处理器补上 id 就自动生效）。
   */
  toolCallId?: string;
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

    /**
     * 按「模型给的顺序」切调度组：连续的可并发调用合成一组并行跑，
     * 不可并发的调用各自独占一组。**组间严格保序。**
     *
     * ## 为什么不能像以前那样「先把所有可并发工具跑完」
     *
     * 旧实现把调用分成两个队列（`concurrentBatch` / `sequentialQueue`），
     * 先整批跑完可并发的、再跑其余的 —— **模型给的顺序被丢弃**。具体失效场景：
     *
     * ```
     * 模型发出:  read(a.ts)  →  edit(a.ts)      （顺序正确）
     * 旧实现实际: edit(a.ts)  →  read(a.ts)      （顺序反了，中间隔着整批并行组）
     * ```
     *
     * 模型按「先读后写」组织调用是有意义的：它可能依赖刚读到的内容。顺序被打乱后，
     * 它看到的结果与自己的推理链不一致，只能重读重试。
     *
     * 新实现把 `read(a.ts)` 收成单元素组先跑、`edit(a.ts)` 再跑，顺序保住；
     * 而 `read(a) → read(b) → edit(c)` 仍会合成一组并行。
     *
     * 注意：**结果提交顺序**一直是对的（`executeBatch` 内按 `slots` 索引回填），
     * 这里修的只是**执行顺序**。
     */
    type Group = { parallel: boolean; calls: StreamingToolCall[] };
    const groups: Group[] = [];
    for (const tc of toolCalls) {
      const safe = this.config.concurrencySafeTools.includes(tc.name);
      const last = groups[groups.length - 1];
      if (safe) {
        // 只与**紧邻**的可并发调用同组，不跨越不可并发的调用
        if (last && last.parallel) last.calls.push(tc);
        else groups.push({ parallel: true, calls: [tc] });
      } else {
        groups.push({ parallel: false, calls: [tc] });
      }
    }

    for (const group of groups) {
      if (group.parallel) {
        yield* this.executeBatch(group.calls, ctx, toolHandler, results);
      } else {
        yield* this.executeSingle(group.calls[0], ctx, toolHandler, results);
      }
    }

    yield { type: "batch_complete", results };
    return results;
  }

  /**
   * 一批**可并发**工具的执行。
   *
   * ## 有界 rolling pool（第 119 轮）
   *
   * 旧实现把这一批按 `maxConcurrent` 切成**定长块**、块间是屏障：
   * 12 个调用、上限 5 ⇒ `5 → 5 → 2`，第二批必须等第一批**全部**完成。
   * 只要有一个慢调用，整条流水线就停在那里 —— 最坏情况从
   * `ceil(n/cap)` 份变成「所有慢调用串起来」。
   *
   * 现在改成**有界 rolling pool**：维护 `maxConcurrent` 个在跑的任务，
   * 任何**一个**完成就立刻补下一个（对标 DSH 的
   * `DEFAULT_MAX_PARALLEL_TOOL_CALLS` + bounded rolling pool 语义）。
   *
   * ## 同时保住「按模型顺序提交」（这一条不能丢）
   *
   * README/DSH 都强调结果要 model-ordered：结果顺序决定下一次请求的前缀，
   * 顺序一变前缀缓存就失效。所以这里不是「谁先完成谁先 yield」，而是：
   *
   * - 所有调用**同时**在跑（rolling pool，吞吐最大化）；
   * - 结果写进按模型顺序编号的 `entries`；
   * - **只有从头开始连续完成的那一段**才会被 yield（`from` 指针单调前进）；
   * - 因此 yield 顺序**恒等于模型顺序**，而执行顺序是并发的。
   *
   * 第 1 个调用慢、后面几个快时，快的会先在 `entries` 里就位，等第 1 个完成
   * 后**一起按序**交出 —— 既不乱序，也没有白等（它们本来就在并行跑）。
   */
  private async *executeBatch(
    toolCalls: StreamingToolCall[],
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
    results: ToolCallResult[],
  ): AsyncGenerator<ToolExecutorEvent, void, unknown> {
    type Entry =
      | { kind: "ok"; tc: StreamingToolCall; result: ToolCallResult }
      | { kind: "err"; tc: StreamingToolCall; message: string };

    /** 按模型顺序编号的结果槽；`undefined` = 尚未完成。 */
    const entries: Array<Entry | undefined> = new Array(toolCalls.length);
    /** 下一个要提交的位置 —— 单调前进，保证 yield 顺序 == 模型顺序。 */
    let from = 0;

    /**
     * 「有新情况了」的通知：有完成就立刻唤醒主循环，没有就直接等。
     *
     * ## 为什么不用轮询
     *
     * 轮询要引入一个任意的间隔（比如每 150ms 看一眼），既给每次提交加上
     * 最多一个间隔的延迟，又让「什么时候交出结果」变成时间函数而非状态函数。
     *
     * ## 为什么这个简单形态不会丢唤醒（结论来自实测，不是推理）
     *
     * 一度担心「唤醒发生在主循环判定 `!committed` 与真正 await 之间」会永久挂住，
     * 于是加过代次计数。实测后撤掉了：**丢唤醒在这里不成立**，理由有两条，
     * 且第二条是硬保证 ——
     *
     * 1. `runOne` 的 `wake()` 在 `finally` 里，**每个**调用无论成功、失败、
     *    还是 `this.running.delete()` 抛错（`wake()` 放在最内层 finally）
     *    都必然唤醒一次；
     * 2. `wake()` 只可能在**生成器挂起期间**（即主循环停在某个 `yield`）执行 ——
     *    因为 `runOne` 是 `void` 出去的后台 promise，而主循环的同步段里
     *    没有 await 点可供它插入。于是主循环每次从 `yield` 恢复后，
     *    `entries` 一定是最新的；即使某次唤醒的 promise 已被替换掉，
     *    循环也会在下一圈凭 `entries[from] !== undefined` 直接提交，不必等待。
     *
     * 定向量测（`.preview-shot/_probe-rolling-wakeup.mjs`）：20 轮 × 12 个
     * 随机耗时调用，**全部 12/12 提交、最慢 109ms、无一次挂起**。
     */
    let notify: () => void = () => {};
    let signal = new Promise<void>((r) => {
      notify = r;
    });
    const wake = (): void => {
      const r = notify;
      signal = new Promise<void>((res) => {
        notify = res;
      });
      r();
    };

    /** 跑一个调用；完成/失败都写进自己的槽并唤醒主循环。 */
    const runOne = async (idx: number): Promise<void> => {
      const tc = toolCalls[idx];
      try {
        const result = await this.runOneTool(tc, ctx, toolHandler);
        tc.status = "completed";
        tc.result = result;
        entries[idx] = { kind: "ok", tc, result };
      } catch (error: any) {
        tc.status = "error";
        tc.error = error.message;
        entries[idx] = { kind: "err", tc, message: error.message };
      } finally {
        this.running.delete(tc.id);
        wake();
      }
    };

    // 启动窗口：先填满 maxConcurrent 个，之后完成一个补一个
    let next = 0;
    const window = Math.max(1, this.config.maxConcurrent);
    while (next < toolCalls.length && next < window) {
      const idx = next++;
      const tc = toolCalls[idx];
      tc.status = "running";
      tc.abortController = new AbortController();
      this.running.set(tc.id, tc);
      // tool_start 在**真正开始跑**的时候发（旧实现是等整批跑完再补发），
      // 这样界面上的「正在执行」与真实执行时刻一致
      yield { type: "tool_start", toolCall: tc };
      void runOne(idx);
    }

    while (from < toolCalls.length) {
      // 提交所有**从头连续完成**的结果
      let committed = false;
      while (from < toolCalls.length && entries[from] !== undefined) {
        const entry = entries[from]!;
        if (entry.kind === "err") {
          yield { type: "tool_error", toolCall: entry.tc, error: entry.message };
        } else {
          yield { type: "tool_complete", toolCall: entry.tc, result: entry.result };
          results.push(entry.result);
        }
        // 槽用完就释放，长批次下别一直拿着整批结果
        entries[from] = undefined;
        from++;
        committed = true;
      }

      // 补位：窗口里空出来的位置立刻填下一个
      while (next < toolCalls.length && this.running.size < window) {
        const idx = next++;
        const tc = toolCalls[idx];
        tc.status = "running";
        tc.abortController = new AbortController();
        this.running.set(tc.id, tc);
        yield { type: "tool_start", toolCall: tc };
        void runOne(idx);
      }

      if (from >= toolCalls.length) break;
      if (!committed) {
        // 还没轮到 `from` 完成 —— 等唤醒（不是轮询）。
        // 不丢唤醒的理由见 `wake()` 上方注释：每个调用必唤醒一次，
        // 且唤醒只发生在生成器挂起期间，主循环恢复后 `entries` 一定是最新的。
        await signal;
      }
    }

    // P1-A: Enforce per-message tool result budget
    await enforcePerMessageBudget(results, ctx);
  }

  /**
   * 跑一个工具调用 —— 从安全扫描到落盘的完整链路。
   *
   * 这是 `executeBatch` 的 rolling pool 里「一个槽位」的执行体。
   * 抽出来是因为 rolling pool 需要**按需**启动单个调用（谁完成就补谁），
   * 而不是像旧实现那样一次 `Promise.all` 起一整块。
   *
   * 语义与旧的内联版本**逐条对齐**（这是重构成败的关键，任何一条走样都是回归）：
   * - 已中止 ⇒ 抛 `Aborted`；
   * - `errorSource === "tool"` 的结果**不**抛错（工具自己汇报的失败要让模型看到文本去纠正），
   *   其余 `status:"error"` 一律抛出走 catch（第 84 波的取舍，注释保留在下面）；
   * - 超时只对非白名单工具生效（bash 自己管超时；write/edit 等要弹确认框）；
   * - 结果照旧做安全警告前置与超大结果落盘。
   */
  private async runOneTool(
    tc: StreamingToolCall,
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
  ): Promise<ToolCallResult> {
    /* 超时定时器句柄：在 finally 里取消（见 timeoutTimer 的说明） */
    let toolTimer: { promise: Promise<never>; cancel: () => void } | null = null;

    try {
      if (ctx.abort?.aborted || tc.abortController?.signal.aborted) {
        throw new Error("Aborted");
      }

      // F2.5: Security scan before execution
      const securityWarning = scanParametersForSecrets(tc.name, tc.input);

      // bash manages its own timeout via timeout_ms parameter; spawn/wait_subagent never timeout
      // write/edit/multi_edit may trigger user confirmation dialogs (overwrite, permission) — no timeout
      const noTimeoutTools = ["bash", "wait_for_subagent", "spawn_subagent", "subagent", "send_message", "interrupt_agent", "list_agents", "report", "write", "edit", "multi_edit"];
      const useTimeout = !noTimeoutTools.includes(tc.name);

      // P0-2: Route through ToolPipeline if initialized (5-layer waterfall)
      const pipeline = getToolPipeline();
      const pipelineResult = pipeline.execute(
        tc.name, tc.input, { ...ctx, abort: tc.abortController!.signal, toolCallId: tc.id }, toolHandler,
      );

      const result = await Promise.race([
        pipelineResult.then(pr => {
          // S0-1 fix: Pipeline catches tool exceptions internally and returns
          // status:"error" results. Re-throw to trigger catch block for
          // tool_error event emission, preserving the original error message.
          //
          // 第 84 波：**工具自己汇报的失败**（errorSource:"tool"，例如
          // `Error: oldString not found`）不在此列 —— 它要作为 tool_complete
          // 带着 status:"error" 返回，让模型看到文本并纠正，同时界面显示失败；
          // 若一并抛成 tool_error，会累加 consecutiveErrors（连错 3 次就整轮终止），
          // 反而比修复前更容易卡死。
          if (pr.result.status === "error" && pr.result.errorSource !== "tool") {
            const errMsg = pr.result.error || pr.result.output || "Tool execution failed";
            throw new Error(errMsg);
          }
          return pr.result;
        }),
        useTimeout
          ? (toolTimer = this.timeoutTimer(this.config.toolTimeout)).promise
          : new Promise<never>(() => {}),
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

      return result;
    } finally {
      toolTimer?.cancel();
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
    /* 超时定时器句柄：在 finally 里取消（见 timeoutTimer 的说明） */
    let toolTimer: { promise: Promise<never>; cancel: () => void } | null = null;

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
        tc.name, tc.input, { ...ctx, abort: tc.abortController.signal, toolCallId: tc.id }, toolHandler,
      );

      const result = await Promise.race([
        pipelineResult.then(pr => {
          // S0-1 fix: Pipeline catches tool exceptions internally and returns
          // status:"error" results. Re-throw to trigger catch block for
          // tool_error event emission, preserving the original error message.
          // 第 84 波：工具自报失败（errorSource:"tool"）除外，见 executeBatch 中的说明。
          if (pr.result.status === "error" && pr.result.errorSource !== "tool") {
            const errMsg = pr.result.error || pr.result.output || "Tool execution failed";
            throw new Error(errMsg);
          }
          return pr.result;
        }),
        useTimeout
          ? (toolTimer = this.timeoutTimer(this.config.toolTimeout)).promise
          : new Promise<never>(() => {}),
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
      toolTimer?.cancel();
      this.running.delete(tc.id);
    }
  }

  /**
   * 工具执行超时定时器（第 44 轮渲染层审计 P2-3）。
   *
   * 原来是 `new Promise((_, reject) => setTimeout(...))` 直接丢进 `Promise.race` ——
   * **race 的败者不会被取消**，所以只要工具在超时前完成（几乎每次都是），这个 60 秒定时器
   * 就留在那里，到期时产生一次无人观察的拒绝：
   * `Unhandled Rejection: Tool execution timed out after 60000ms`（用户无感，只污染日志与诊断导出），
   * 长时间多工具会话里会持续累积。
   *
   * 现在返回**可取消的句柄**：调用方在 finally 里 `cancel()`（清掉定时器）；
   * 同时给 promise 挂一个空 catch —— 即使 cancel 与超时擦肩而过，这个拒绝也**永远是被观察过的**，
   * 不会再变成未处理拒绝。
   */
  private timeoutTimer(ms: number): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms`)), ms);
    });
    // 拒绝必须始终有观察者：race 结束后（或调用方忘了 cancel 时）不会变成 unhandledRejection
    promise.catch(() => {});
    return {
      promise,
      cancel: () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
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
