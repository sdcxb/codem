import type { ToolCallResult, LLMMessage } from "../llm/types";
import { maybePersistToolResult, shouldPersistResult } from "./tool-result-storage";
import { getToolPipeline, type ToolPipelineHost } from "./tool-pipeline";
import { DEFAULT_CONCURRENCY_SAFE_TOOLS } from './concurrency-policy';
import { resolveToolContract, resolveToolTimeout, type ResolvedToolContract } from './tool-contract';
import { credentialShapeTestPattern } from '../utils/credential-shapes';

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
  contractOf?: (name: string) => { persistResult: boolean },
): Promise<void> {
  let totalSize = results.reduce((sum, r) => sum + (r.output?.length || 0), 0);
  if (totalSize <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) return;

  // Sort by output size descending — persist largest first
  const sortable = results
    .filter(r => r.output && shouldPersistResult(r.name, contractOf))
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
  /*
   * API key / Bearer 的**形状**来自唯一来源 `core/utils/credential-shapes.ts`
   * （第 188 波 R5）—— 本文件原来自己写了一份窄口径（正文只允许字母数字），
   * 于是模型把 `sk-proj-…` / `SK-…` 写进文件时**不警告**（普查那份也有同样的漏报）。
   * `credentialShapeTestPattern` 给的是**去 `g`** 的副本：这里的用法是逐次 `test()`，
   * 带 `g` 的正则会因 `lastIndex` 变成有状态、隔次漏报。
   */
  credentialShapeTestPattern("apiKeyStrong"), // API keys（sk-/pk-）
  credentialShapeTestPattern("bearer"), // Bearer tokens
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
  /**
   * 可并发工具的名字名单。
   *
   * **第 120 轮起这是「兜底」，不是主判据** —— 主判据是工具自己的
   * `contract.concurrencySafe`（经 `resolveToolContract` 解析，缺省保守）。
   * 保留它的原因有两条：①运行时注册的工具（MCP）不可能带声明；
   * ②调用方（测试、桥接层）可能只给名字。
   * 解析顺序见 `isConcurrencySafe()`。
   */
  concurrencySafeTools: string[];
  toolTimeout: number;
  abortSiblingsOnError: boolean;
  /**
   * 契约查询器：给工具名，返回它的完整契约。
   *
   * 由 `agentic-loop` 注入（它持有 ToolRegistry）。未注入时只靠
   * `concurrencySafeTools` 兜底 —— 这样测试与独立用法不必构造 registry。
   */
  contractOf?: (toolName: string) => ResolvedToolContract;
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
  // 兜底名单（见 `ToolExecutorConfig.concurrencySafeTools` 的说明）。
  // 契约化之后主判据是工具自己的声明；这份名单只在拿不到契约时用。
  concurrencySafeTools: DEFAULT_CONCURRENCY_SAFE_TOOLS,
  toolTimeout: 60000, // 60 seconds for regular tools
  abortSiblingsOnError: false,
  // contractOf 默认不注入：拿不到契约时退化为上面的名字名单
};

/**
 * 一次调用是否可与其他调用并发。
 *
 * **契约优先、名字兜底**（照 zcode `scheduler.ts:97` 的形态）：
 * 1. 能拿到契约 ⇒ 用 `contract.concurrencySafe`（缺省保守：只读才可并发）；
 * 2. 拿不到契约（未注入 contractOf，或工具未注册）⇒ 查 `concurrencySafeTools`。
 *
 * 注意**不能**反过来（名字优先）—— 那会让一份手写名单继续覆盖工具自己的声明，
 * 就又回到「7 组名单」的老问题。
 */
function isConcurrencySafe(
  toolName: string,
  config: { concurrencySafeTools: string[]; contractOf?: (n: string) => ResolvedToolContract },
): boolean {
  if (config.contractOf) {
    try {
      return config.contractOf(toolName).concurrencySafe;
    } catch {
      // 契约查询器抛错时不要静默放行并发（安全侧：独占）
      return false;
    }
  }
  return config.concurrencySafeTools.includes(toolName);
}

/**
 * 工具调用**超时**的机器可读码。
 *
 * 为什么不能只靠错误文本：上层（循环、委派、用量统计）需要"这是超时、不是工具自己
 * 报的失败"这个事实，而文本匹配在措辞一改就失效。超时时错误对象与结果载荷都带它。
 */
export const TOOL_TIMEOUT = "TOOL_TIMEOUT";

/**
 * **未派发即中止**的机器可读码（对标 DSH `TOOL_ABORTED_BEFORE_DISPATCH`）。
 *
 * 中止发生在调用真正开始之前时，调用不该执行、但必须在事件流里留下一条有序结果
 * （否则界面上它永远停在「运行中」，回放也配不上对）。
 */
export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";

/** 与 DSH `appendSkippedToolCall` 同文的合成结果文本 */
const ABORTED_BEFORE_DISPATCH_MESSAGE = "Error: tool call aborted before dispatch";

export type ToolExecutorEvent =
  | { type: "tool_start"; toolCall: StreamingToolCall }
  | { type: "tool_progress"; toolCallId: string; progress: string }
  | { type: "tool_complete"; toolCall: StreamingToolCall; result: ToolCallResult }
  | { type: "tool_error"; toolCall: StreamingToolCall; error: string; code?: string }
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
  /**
   * ★ 第 185 波（T1）：**这一轮调用所属 loop 的管线宿主回调**。
   *
   * ## 为什么必须按次放在 ctx 上
   *
   * 工具管线是**进程级单例**，而主会话与每个子智能体各持一个 `AgenticLoop`
   * （`index.ts` 的 `getAgenticLoop(agentId, sessionId, scopedTools)` 带
   * `toolRegistryOverride` ⇒ 与主 loop 是两个实例）。原来闸门（权限 / 计划模式 /
   * 沙箱）读的是 `initDefaultPipeline` **最后初始化那个 loop 捕获的闭包** ⇒
   * 主 loop 的调用会落到子智能体的 `checkPermission` 上，而子智能体通常没有
   * `onPermissionRequest` ⇒ 按 fail-closed 被拒，**本该弹的确认框永远不弹**。
   *
   * 现在由每个 loop 在构造本轮 `ctx` 时带上自己那份回调，管线中间件**优先用它**
   * （见 `tool-pipeline.ts` 的 `hostFor`）⇒ 闸门只跟"这次调用是谁发的"有关，
   * 与"谁最后初始化了管线"无关。
   */
  pipelineHost?: ToolPipelineHost;
  /**
   * ★ 第 185 波（T4）：**这次调用已被判失败**的共享标志。
   *
   * ## 为什么需要它（`ctx.abort.aborted` 判不准）
   *
   * 超时那支只 `controller.abort()` + `reject`（放弃等待），**没有任何东西取消管线 promise**
   * ⇒ 工具不观察 `ctx.abort` 时管线照旧跑完，`EventLogFinalizeMiddleware` 会写一条
   * `status:"completed"` 的 `tool_result`，而调用方已经 `yield tool_error` ——
   * 同一个 `toolCallId` 两份相反的事实。
   *
   * 判据为什么**不能**用 `ctx.abort.aborted`：那是"取消信号发出去了"，而不是"这次调用
   * 已被判失败"。用户点 ■（`abortAll`）时两者会分叉 —— 在飞工具若在收到取消前就跑完并
   * 返回成功，调用方**照样 yield `tool_complete`**（放弃等待 ≠ 否定结果），此时按
   * `aborted` 写 `error` 反而是新的两份真相。所以标志必须由**真正做出失败裁决的那一处**
   * 置位：`timeoutTimer` 在 `controller.abort()` **同一个同步段**里（那一刻 race 已经决定拒绝）。
   *
   * 用对象而不是布尔值：管线拿到的是 `{...ctx}` 的**拷贝**，只有引用类型能共享。
   */
  abandoned?: { value: boolean };
  metadata(input: { title?: string; metadata?: Record<string, any> }): void;
}

// ========== Streaming Tool Executor ==========
export class StreamingToolExecutorImpl {
  private config: ToolExecutorConfig;
  private running: Map<string, StreamingToolCall> = new Map();
  /**
   * 中止标志：`abortAll()` 置位，**派发循环**逐处检查。
   *
   * ## 为什么必须有这个标志（不能只靠 abortController）
   *
   * `abortAll()` 只中止**在飞**调用并清空 `running`。而补位循环的判据是
   * `this.running.size < window` —— 清空之后 `0 < window` 恒成立，于是**排队中的调用
   * 会带着全新的、从未被中止的 controller 继续派发**（用户点了 ■，工具却照样开始跑）。
   * `ctx.abort` 也救不了：循环侧刻意传 `abort: undefined`（每个调用用各自的 controller）。
   *
   * 所以判据必须是**实例级的事实**（"这一批已经中止"），而不是"当前有没有在飞调用"。
   * 复位点只在 `execute()` 入口：新的一次执行 = 新的一批调用，否则一次中止会让执行器永久失效。
   */
  private abortRequested = false;

  constructor(config?: Partial<ToolExecutorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async *execute(
    toolCalls: StreamingToolCall[],
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
  ): AsyncGenerator<ToolExecutorEvent, ToolCallResult[], unknown> {
    /*
     * ⚠️ 这里**刻意不**复位 `abortRequested`。
     *
     * 复位点必须在**回合边界**（`AgenticLoop.run()` 调用 `clearAbort()`），不能放在这里：
     * 用户点 ■ 时，最常发生的是"模型正在流式输出"——那时本轮的 `execute()` 还没被调用，
     * 若在入口复位，排队中的调用会带着全新的 controller 开跑（正是本条缺陷的形态）。
     * 也就是说：**中止一旦发生，本回合余下的一批批调用一个都不许派发**。
     */
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
      const safe = isConcurrencySafe(tc.name, this.config);
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
      /* 中止之后**一个组都不许再进**：进入即等于派发（见 abortRequested 的说明） */
      if (this.abortRequested) break;
      if (group.parallel) {
        yield* this.executeBatch(group.calls, ctx, toolHandler, results);
      } else {
        yield* this.executeSingle(group.calls[0], ctx, toolHandler, results);
      }
    }

    /**
     * 中止后**补合成结果**（对标 DSH `appendSkippedToolCall`）。
     *
     * 判据是 `status === "pending"`：只有真正派发过的调用才会被置成 running/completed/error，
     * 所以"还是 pending"= **从未开始执行**。它们不执行、不产生副作用，但必须有交代 ——
     * 否则界面上的调用永远停在「运行中」，而事件流里连一条失败都看不到。
     */
    for (const tc of toolCalls) {
      if (tc.status !== "pending") continue;
      const result = this.skippedResult(tc);
      results.push(result);
      yield {
        type: "tool_error",
        toolCall: tc,
        error: ABORTED_BEFORE_DISPATCH_MESSAGE,
        code: TOOL_ABORTED_BEFORE_DISPATCH,
      };
    }

    yield { type: "batch_complete", results };
    return results;
  }

  /**
   * 从未派发就被中止的调用的合成结果。
   *
   * `isError: true` 是给 `tool-result-status.ts` 的**显式失败声明**（它优先于文本启发式），
   * `code` 让上层不必做文本匹配。
   */
  private skippedResult(tc: StreamingToolCall): ToolCallResult {
    tc.status = "error";
    tc.error = ABORTED_BEFORE_DISPATCH_MESSAGE;
    const result: ToolCallResult = {
      id: tc.id,
      name: tc.name,
      input: tc.input,
      output: ABORTED_BEFORE_DISPATCH_MESSAGE,
      status: "error",
      error: ABORTED_BEFORE_DISPATCH_MESSAGE,
    };
    (result as { isError?: boolean; code?: string }).isError = true;
    (result as { isError?: boolean; code?: string }).code = TOOL_ABORTED_BEFORE_DISPATCH;
    return result;
  }

  /** 派发前的中止错误：与 `skippedResult` 同一套码与文本（走 catch 统一成形） */
  private abortedBeforeDispatchError(): Error {
    const err = new Error(ABORTED_BEFORE_DISPATCH_MESSAGE) as Error & { code?: string };
    err.code = TOOL_ABORTED_BEFORE_DISPATCH;
    return err;
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
      | { kind: "err"; tc: StreamingToolCall; message: string; code?: string };

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
        entries[idx] = { kind: "err", tc, message: error.message, code: error?.code };
      } finally {
        this.running.delete(tc.id);
        wake();
      }
    };

    // 启动窗口：先填满 maxConcurrent 个，之后完成一个补一个
    let next = 0;
    const window = Math.max(1, this.config.maxConcurrent);
    /* 中止后不许再派发任何调用（补位循环的清空会让窗口恒有空位，见 abortRequested 的说明） */
    while (!this.abortRequested && next < toolCalls.length && next < window) {
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
          yield {
            type: "tool_error",
            toolCall: entry.tc,
            error: entry.message,
            ...(entry.code ? { code: entry.code } : {}),
          };
        } else {
          yield { type: "tool_complete", toolCall: entry.tc, result: entry.result };
          results.push(entry.result);
        }
        // 槽用完就释放，长批次下别一直拿着整批结果
        entries[from] = undefined;
        from++;
        committed = true;
      }

      if (this.abortRequested) {
        /**
         * 中止：**停止补位**，但把已经派发出去的调用**排空**（按模型顺序交出它们的结果），
         * 未派发的（`idx >= next`）一个都不启动 —— 它们留给 `execute()` 统一补合成结果。
         *
         * 这里不能用原来的 `if (!committed) await signal`：中止后 `running` 已被清空，
         * 若还有未派发的调用，`entries[from]` 永远不会被填上 —— 判据会永久挂住。
         */
        if (from >= next) break;
        await signal;
        continue;
      }

      // 补位：窗口里空出来的位置立刻填下一个（中止后一个都不填 —— 判据与上面的中止分支同源）
      while (!this.abortRequested && next < toolCalls.length && this.running.size < window) {
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
    await enforcePerMessageBudget(results, ctx, this.config.contractOf);
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
      /* 中止后不再开始执行：这个调用从未派发 ⇒ 合成"未派发即中止"结果（不产生任何副作用） */
      if (this.abortRequested) {
        throw this.abortedBeforeDispatchError();
      }
      if (ctx.abort?.aborted || tc.abortController?.signal.aborted) {
        throw new Error("Aborted");
      }

      // F2.5: Security scan before execution
      const securityWarning = scanParametersForSecrets(tc.name, tc.input);

      // 超时由**工具自己的契约**决定（第 120 轮起）。
      //
      // 契约化之前这里有一份 11 个名字的 `noTimeoutTools`，而 `executeSingle` 里
      // 另有一份 6 个名字的 —— 同一批工具走不同路径就有不同超时行为。
      // 现在两份都删掉，改读 `contract.timeoutMs`：缺省用执行器默认预算，
      // 要「永不超时」的工具必须显式声明 `NO_TIMEOUT`（见 tool-contract.ts）。
      const timeout = resolveToolTimeout(
        this.contractFor(tc.name),
        this.config.toolTimeout,
      );
      const useTimeout = timeout.useTimeout;

      // P0-2: Route through ToolPipeline if initialized (5-layer waterfall)
      const pipeline = getToolPipeline();
      /**
       * ★ 第 185 波（T4）：这次调用的「已被判失败」标志（超时那支会置位，见 `timeoutTimer`）。
       * 必须是**同一个对象引用**被传进管线 ctx —— finalize 层读它来决定写不写 `completed`。
       */
      const abandoned = { value: false };
      const pipelineResult = pipeline.execute(
        tc.name,
        tc.input,
        { ...ctx, abort: tc.abortController!.signal, toolCallId: tc.id, abandoned },
        toolHandler,
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
          ? (toolTimer = this.timeoutTimer(timeout.timeoutMs, tc.abortController!, () => {
              abandoned.value = true;
            })).promise
          : new Promise<never>(() => {}),
      ]);

      // F2.5: Append security warning to result if detected
      if (securityWarning && result.output) {
        result.output = `${securityWarning}\n\n${result.output}`;
      } else if (securityWarning) {
        (result as any).output = securityWarning;
      }

      // P1-5: Persist large tool results to disk
      if (result.output && shouldPersistResult(tc.name, this.config.contractOf)) {
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

  /**
   * 取工具的完整契约。
   *
   * 拿不到 `contractOf` 时返回一份**保守缺省**（不并发、要超时、落盘），
   * 而不是「假装它是安全的」。这样测试与独立用法不必构造 registry 也能跑，
   * 且缺省永远落在安全侧。
   */
  private contractFor(toolName: string): ResolvedToolContract {
    if (this.config.contractOf) {
      try {
        return this.config.contractOf(toolName);
      } catch {
        // 查询器抛错 ⇒ 落到下面那份保守缺省，不静默放行
      }
    }
    return resolveToolContract(undefined, toolName);
  }

  private async *executeSingle(
    tc: StreamingToolCall,
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
    results: ToolCallResult[],
  ): AsyncGenerator<ToolExecutorEvent, void, unknown> {
    /*
     * 中止后**一个都不许再派发**。并且这个检查必须在 `yield tool_start` **之前**：
     * 队列里剩下的调用既然从未开始，就不该让界面显示"开始执行"。
     * （`tool_start` 之后才发生中止的情况由下面 try 里的同一判据兜住。）
     */
    if (this.abortRequested) {
      const skipped = this.skippedResult(tc);
      results.push(skipped);
      yield {
        type: "tool_error",
        toolCall: tc,
        error: ABORTED_BEFORE_DISPATCH_MESSAGE,
        code: TOOL_ABORTED_BEFORE_DISPATCH,
      };
      return;
    }

    yield { type: "tool_start", toolCall: tc };

    tc.status = "running";
    tc.abortController = new AbortController();
    this.running.set(tc.id, tc);
    /* 超时定时器句柄：在 finally 里取消（见 timeoutTimer 的说明） */
    let toolTimer: { promise: Promise<never>; cancel: () => void } | null = null;

    try {
      /* 从 `tool_start` 发出到真正执行之间可能发生中止 —— 未开始的调用一律不执行 */
      if (this.abortRequested) {
        throw this.abortedBeforeDispatchError();
      }
      if (ctx.abort?.aborted || tc.abortController.signal.aborted) {
        throw new Error("Aborted");
      }

      // F2.5: Security scan before execution
      const securityWarning = scanParametersForSecrets(tc.name, tc.input);

      // 超时同样读工具契约 —— 这里原来有一份 6 个名字的 `noTimeoutTools`，
      // 与 runOneTool 里那份 11 个名字的**不一致**（少了 subagent / send_message /
      // interrupt_agent / list_agents / report）。同一批工具走单发路径与批量路径
      // 就有不同超时行为，这正是多份真相的必然结果。现在两处都读契约。
      const timeout = resolveToolTimeout(
        this.contractFor(tc.name),
        this.config.toolTimeout,
      );
      const useTimeout = timeout.useTimeout;

      // S0-1: Route through ToolPipeline (same as executeBatch) to ensure
      // all tools go through the 5-layer waterfall, including EventLog finalize.
      const pipeline = getToolPipeline();
      /** ★ 第 185 波（T4）：与 `runOneTool` 同形 —— 见那里的说明。 */
      const abandoned = { value: false };
      const pipelineResult = pipeline.execute(
        tc.name,
        tc.input,
        { ...ctx, abort: tc.abortController.signal, toolCallId: tc.id, abandoned },
        toolHandler,
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
          ? (toolTimer = this.timeoutTimer(timeout.timeoutMs, tc.abortController, () => {
              abandoned.value = true;
            })).promise
          : new Promise<never>(() => {}),
      ]);

      // F2.5: Append security warning to result if detected
      if (securityWarning && result.output) {
        result.output = `${securityWarning}\n\n${result.output}`;
      } else if (securityWarning) {
        (result as any).output = securityWarning;
      }

      // P1-5: Persist large tool results to disk
      if (result.output && shouldPersistResult(tc.name, this.config.contractOf)) {
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
      /*
       * 结构化失败：`isError: true` 是给 `tool-result-status.ts` 的**显式声明**
       * （它优先于"output 首行像不像错误"的文本启发式），`code` 让上层不必匹配文本
       * （超时 = `TOOL_TIMEOUT`，未派发即中止 = `TOOL_ABORTED_BEFORE_DISPATCH`）。
       */
      (errorResult as { isError?: boolean; code?: string }).isError = true;
      if (error?.code) (errorResult as { code?: string }).code = error.code;
      results.push(errorResult);

      yield {
        type: "tool_error",
        toolCall: tc,
        error: error.message,
        ...(error?.code ? { code: error.code as string } : {}),
      };
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
   *
   * ## 超时必须**真正中止工具**（不只是放弃等待）
   *
   * 超时原来只 `reject(...)`：`Promise.race` 放弃等待，而工具**照旧在跑**，
   * 副作用（写文件、跑命令）照样落盘 —— 模型却被告知它失败了。判据二义：
   * 一边是"失败"，一边是"成果真的写进去了"。
   *
   * 现在超时时**先** `controller.abort()`（那个 signal 就是交给工具的 `ctx.abort`，
   * 见 `pipeline.execute(..., { ...ctx, abort: tc.abortController.signal })`），
   * **再** reject。顺序是判据的一部分：反过来时工具可能还没观察到取消就被上报失败。
   * （`bash` 早先单独修过同一形态；这里把修法提到执行器这一层，所有工具都受益。）
   *
   * ## 中止失败**不能只打日志**
   *
   * 如果 `abort()` 自己抛了，那么"工具已经被叫停"这个前提就不成立 —— 工具**可能还在跑**，
   * 副作用（写文件、跑命令）还会继续落盘。这比一次普通的超时严重得多，
   * 而原来这里只 `console.warn` 然后照旧 reject 一句"超时"，把这件事完全埋掉。
   *
   * 现在把它并进**要上抛的那个错误**：消息里加上原因，另挂一个 `abortFailure` 字段
   * 供上层/测试机器可读地判定。模型与用户因此知道"这次失败之外还有一份可能仍在运行的副作用"。
   *
   * ## ★ 第 185 波（T4）：超时同时是「这次调用已被判失败」的**唯一权威时刻**
   *
   * `onAbandon` 在 `controller.abort()` 的**同一个同步段**里被调用（那一刻 race 已经决定
   * reject）—— 管线 finalize 层据此不再写 `completed` 的 `tool_result`。
   * 为什么不复用 `ctx.abort.aborted`：那是"取消信号发出去了"，用户点 ■ 时它与"已判失败"
   * 会分叉（在飞工具可能已经跑完并返回成功）。详见 `ToolExecutorContext.abandoned`。
   */
  private timeoutTimer(
    ms: number,
    controller?: AbortController,
    onAbandon?: () => void,
  ): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Tool execution timed out after ${ms}ms`) as Error & {
          code?: string;
          abortFailure?: string;
        };
        err.code = TOOL_TIMEOUT;
        /* 先让工具看到取消（协作式停止：杀掉自己的子进程/网络请求/循环）。
           中止失败时把原因并进 err —— 见上面「中止失败不能只打日志」。 */
        try {
          controller?.abort();
        } catch (abortErr) {
          const detail = abortErr instanceof Error ? abortErr.message : String(abortErr);
          err.abortFailure = detail;
          err.message =
            `${err.message}; moreover the abort signal could not be delivered ` +
            `(the tool may still be running and its side effects may still land): ${detail}`;
        }
        /* ★ 第 185 波（T4）：同一个同步段里置"已放弃"标志（在 reject 之前 —— 顺序是判据的一部分） */
        try {
          onAbandon?.();
        } catch {
          /* 标志只是诊断/记录用，绝不能因为它自己抛错而改变超时语义 */
        }
        reject(err);
      }, ms);
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

  /**
   * 中止在飞调用，并**关掉本回合的派发闸门**。
   *
   * 只中止在飞调用是不够的：补位循环的判据是 `running.size < window`，
   * 清空 `running` 反而会让排队中的调用拿到全新的 controller 继续开跑（详见 `abortRequested`）。
   * 闸门在**新的回合开始**时由 `clearAbort()` 打开（`AgenticLoop.run()` 调用）——
   * 不能在每次 `execute()` 入口复位，否则"流式阶段就被中止"的那一批照样会跑。
   */
  abortAll() {
    this.abortRequested = true;
    for (const [, tc] of this.running) {
      if (tc.abortController) {
        tc.abortController.abort();
      }
    }
    this.running.clear();
  }

  /**
   * 打开派发闸门（**回合边界**的唯一复位点，由 `AgenticLoop.run()` 在每次新回合开头调用）。
   *
   * 为什么需要它：`abortAll()` 之后闸门必须一直关着（否则中止会被同一回合后面的
   * `execute()` 复位掉），但没有复位点的话执行器就永久失效了 —— 一次中止会让**之后
   * 每一个回合**都不再执行任何工具。回合开始 = 新的用户意图 = 打开闸门。
   */
  clearAbort() {
    this.abortRequested = false;
  }

  /** 当前是否处于"已中止、不再派发"的状态（判据给测试与上层观测用） */
  isAborted(): boolean {
    return this.abortRequested;
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
