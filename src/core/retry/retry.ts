// ========== Error Types ==========
import { setSettingJSON } from "../storage/settings";
import { reportActionFailure, reportPersistFailure } from "../storage/persist-failure";

export type RetryableErrorType =
  | "rate_limit"        // HTTP 429
  | "server_error"      // HTTP 5xx
  | "timeout"           // Request timeout
  | "network"           // ECONNRESET, EPIPE, etc.
  | "capacity"          // 529 Overloaded
  | "sse_timeout";      // SSE chunk timeout

export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Base delay in milliseconds */
  baseDelay: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Total timeout in milliseconds */
  totalTimeout: number;
  /** Whether to respect Retry-After header */
  respectRetryAfter: boolean;
}

/**
 * **默认重试策略**（第 191 波 O-41：证据与产品决策都记在这里）。
 *
 * ## 最坏路径的实测口径（`src/test/retry-budget.test.ts` 的 `RETRY-BUDGET-1a/1b/1c`）
 *
 * - **退避等待之和**：`maxAttempts = 10` ⇒ 最多 9 次重试，逐次 500ms × 2ⁿ 并夹到 `maxDelay`：
 *   `500+1000+2000+4000+8000+16000+32000+64000+128000 = 255_500ms ≈ 4.26 分钟`；
 * - **真正触到 30 分钟的是墙钟**（第 84 波修过）：`totalTimeout` 算的是**含请求耗时**的墙钟，
 *   所以"请求本身很慢"（长上下文一次几分钟）才会先撞预算 —— 判据 `RETRY-BUDGET-1b`
 *   用 6 分钟/次的夹具证明它会在第 2 次就停（只看 sleep 的口径会允许 10 次）；
 * - **`Retry-After` 受单次上限约束**（`RETRY-BUDGET-1c`）：给一小时也会夹到 5 分钟；
 * - **abort 已核实**：退避等待可被「■」立刻打断（`agentic-loop.ts` 的等待段监听 abort）；
 * - **token 花费**：重试是**整请求重发**；同一请求重发时若缓存已建立则按缓存价（DeepSeek 约
 *   1/4 价），但**在建立缓存前失败**（429/过载常常不写缓存）⇒ 最坏按全价算最多 10 次。
 *
 * ## 产品决策（2026-10-08，O-41 要求"未拿到用户答复不许改默认值"）
 *
 * 把上面这份证据连同"30 分钟预算收到 5–10 分钟 / 次数保持 10 / 次数降到 6 / 保持现状"
 * 四个选项交给用户拍板，**用户选择：保持现状（30 分钟 / 10 次），只保留新增的可见提示**。
 * 所以这里的默认值**一个字都没改**；本波只做了两件不改行为的事：
 * ①`RETRY-BUDGET-1a/1b/1c`：把"最坏等待 ≤ 声明预算"变成判据（此前没有任何东西核对这两个口径）；
 * ②`RETRY-BUDGET-2`：预算用尽**用户可见**（旧形态只有 `console.warn`，打包版里用户看不到，
 *   界面上只剩最后那个 provider 错误）。面板里六个参数（含总超时）用户本来就能改。
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 10,
  baseDelay: 500,
  backoffMultiplier: 2,
  maxDelay: 5 * 60 * 1000, // 5 minutes
  totalTimeout: 30 * 60 * 1000, // 30 minutes
  respectRetryAfter: true,
};

// ========== Error Classification ==========

/**
 * 瞬态失败（可退避重试）的**文案**白名单（第 181 波，见 `classifyError` 里的长注释）。
 *
 * 只收"这句话只可能出现在瞬态失败里"的写法，宁少勿多 —— 误判成可重试会把
 * 确定性错误拖成 30 分钟的退避循环。
 */
const RETRYABLE_MESSAGE_PATTERNS: RegExp[] = [
  /\bat capacity\b/i, // 供应商容量（Pi #10278 的原文案）
  /\boverloaded\b/i,
  /\boverload(ed)?\b.*\b(try|retry|again|later)\b/i,
  /currently experiencing high demand/i,
  /\b(temporarily|service)\s+unavailable\b/i,
  /\b(server|service)\s+(is\s+)?busy\b/i,
  /**
   * ★ 第 184 波（G2）：**补上 Pi v1.1.0 的两个原文案**（`ai/src/utils/retry.ts:30-34`）。
   *
   * 上面那条 `\b(server|service)\s+(is\s+)?busy\b` 匹配不到这两种真实写法：
   *  · `server_busy` —— 中间是**下划线**，不是空白（`\s+` 不匹配 `_`）；
   *  · `servers are currently busy` —— `server` 后面是 `s` + ` are currently`。
   *
   * 而 `classifyError` 的默认分支是"不可重试"（本文件末尾 `return { isRetryable: false }`），
   * 于是这两种文案会**直接结束回合**（正是 Pi #10543 修的缺陷）。
   * 判据：`retry-classification-capacity.test.ts` 的 RTC-7/RTC-8。
   */
  /\bserver[_ -]?busy\b/i,
  /\bservers?\s+(are\s+)?(currently\s+)?busy\b/i,
  /pending stream has been canceled/i, // HTTP/2 请求发出前连接就没了（Pi #10379）
  /http2 request did not get a response/i,
  /stream (ended|closed) before/i,
  /connection (reset|closed) by peer/i,
  /\bplease retry\b|\btry again later\b/i,
  /**
   * ★ 第 184/185 波：**"流没有正常收尾"是可重试的**。
   *
   * `agentic-loop` 在 `finishReason === "error"`（provider 侧判据：既没有 `finish_reason`
   * 也没有协议终止符 `[DONE]`）时抛 `INCOMPLETE_STREAM`。那不是"确定性失败"——
   * 它的根因是连接被代理/网关**半途掐断**，重发一次通常就好。
   *
   * ⚠️ 这条是**跨线集成缺口**：第 184 波我只在循环里加了抛错，没同时把这类错加入可重试表，
   * 于是它掉进默认的"不可重试"⇒ 一次网络抖动直接结束回合（正是 D3-B 判据抓到的形态）。
   * 判据：`dsh-d3-abort-not-completed.test.ts` 的 D3-B（掐断必须走重试）与
   * `retry-classification-capacity.test.ts` 的 RTC-9。
   */
  /\bINCOMPLETE_STREAM\b/i,
  /ended without a completion marker/i,
];

/**
 * **确定性失败**的文案白名单：命中即判定不可重试，优先于上面那张表。
 *
 * 这些错误即使文案里出现了 `overloaded` / `at capacity` 之类的词，也不该退避重试
 * （例如"不支持的模型名里恰好带了 overloaded"）。
 */
const NON_RETRYABLE_MESSAGE_PATTERNS: RegExp[] = [
  /unsupported (model|parameter|feature)/i,
  /invalid[_ ](api[_ ]?key|request|model|parameter)/i,
  /model not found|no such model|unknown model/i,
  /insufficient (quota|balance|credits)/i,
  /\bunauthorized\b|\bforbidden\b/i,
  /context (length|window) exceeded|maximum context length/i,
  /max_tokens.*(invalid|too large|exceed)/i,
];

export function classifyError(error: unknown): {
  type: RetryableErrorType | null;
  isRetryable: boolean;
  retryAfter?: number;
} {
  if (!error || typeof error !== "object") {
    return { type: null, isRetryable: false };
  }

  const err = error as any;

  // HTTP status code based classification
  if (err.status || err.statusCode) {
    const status = err.status || err.statusCode;

    if (status === 429) {
      // Rate limit - check Retry-After header
      const retryAfter = err.headers?.["retry-after"];
      return {
        type: "rate_limit",
        isRetryable: true,
        retryAfter: retryAfter ? parseInt(retryAfter) * 1000 : undefined,
      };
    }

    /**
     * 529 = 供应商过载（Anthropic 的 Overloaded）。
     *
     * 第 181 波：**这一支原来排在 `5xx` 之后，于是永远不可达** —— 529 落进
     * `status >= 500 && status < 600` 先返回了，`capacity` 这个类型从来没被产出过
     * （用户看到的仍是"可重试"，所以不是行为 bug，但它让"容量类"无法被单独识别、
     * 也就没法做针对性退避）。顺序调换后语义与 Pi 1.0.4 对齐。
     */
    if (status === 529) {
      return { type: "capacity", isRetryable: true };
    }

    if (status >= 500 && status < 600) {
      return { type: "server_error", isRetryable: true };
    }

    // Client errors (4xx except 429) are not retryable
    return { type: null, isRetryable: false };
  }

  // Network errors
  const code = err.code || err.errorCode;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT" || code === "ECONNREFUSED") {
    return { type: "network", isRetryable: true };
  }

  // Timeout errors
  if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
    return { type: "timeout", isRetryable: true };
  }

  // SSE timeout
  if (err.message?.includes("SSE read timed out")) {
    return { type: "sse_timeout", isRetryable: true };
  }

  /**
   * 第 181 波（对标 Pi `3874b3e98` / `5b6c792b4`）：**容量/过载与瞬态传输错误要看文案**。
   *
   * ## 缺陷形态
   *
   * 修复前这里只认 HTTP 状态码（429 / 5xx / 529）与少数 `code` / `name`。可供应商经常
   * **用 200 或 400 带回一句"模型忙"**，或者在连接层抛一个带文案的传输错误：
   *
   * - `Selected model is at capacity`（Pi #10278 的现场文案，当时也是 fail-fast）
   * - `The pending stream has been canceled`（Node `ERR_HTTP2_STREAM_CANCEL`；Pi #10379）
   *
   * 于是本该退避重试的**一次抖动**被当成"确定性失败"，整段对话就此结束。
   *
   * ## 为什么先查"不可重试"再查"可重试"
   *
   * 文案匹配天然容易误伤（例如 `Unsupported model: overloaded-v2` 只提了名字）。
   * 所以：**明确的确定性错误优先**，只有不命中它们、才按"瞬态"重试。
   */
  const message = typeof err.message === "string" ? err.message : "";
  const codeText = typeof code === "string" ? code : "";
  if (NON_RETRYABLE_MESSAGE_PATTERNS.some((re) => re.test(message) || re.test(codeText))) {
    return { type: null, isRetryable: false };
  }
  if (
    RETRYABLE_MESSAGE_PATTERNS.some((re) => re.test(message) || re.test(codeText)) ||
    codeText === "ERR_HTTP2_STREAM_CANCEL"
  ) {
    return { type: "capacity", isRetryable: true };
  }

  return { type: null, isRetryable: false };
}

// ========== Retry State ==========
export interface RetryState {
  attempt: number;
  totalAttempts: number;
  lastError: unknown;
  lastRetryTime: number;
  totalWaitTime: number;
}

// ========== Retry Executor ==========
export class RetryExecutor {
  private config: RetryConfig;
  private state: RetryState;
  /** 本次 execute 的开始时刻（0 = 尚未开始）；用于按**墙钟**核算总预算 */
  private startedAt = 0;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.loadPersistedConfig();
    this.state = {
      attempt: 0,
      totalAttempts: this.config.maxAttempts,
      lastError: null,
      lastRetryTime: 0,
      totalWaitTime: 0,
    };
  }

  /** Load persisted config from SQLite settings */
  private loadPersistedConfig() {
    try {
      // Use globalThis to access settings if available (set by App.tsx after DB init)
      const settings = (globalThis as any).__codemSettings?.getSettingJSON;
      if (typeof settings === 'function') {
        const saved = settings("codem-retry-config", null) as Partial<RetryConfig> | null;
        if (saved) {
          this.config = { ...this.config, ...saved };
        }
      }
    } catch (e) { /* settings not yet available — safe to ignore */ }
  }

  /** Get current config */
  getConfig(): Readonly<RetryConfig> {
    return { ...this.config };
  }

  /** Update and persist config */
  setConfig(updates: Partial<RetryConfig>) {
    this.config = { ...this.config, ...updates };
    this.state.totalAttempts = this.config.maxAttempts;
    try {
      setSettingJSON("codem-retry-config", this.config);
    } catch (e) { reportPersistFailure("retry.setConfig", e, "重试配置未保存，重启后回到默认值"); }
  }

  /** Reset retry state */
  reset() {
    this.state = {
      attempt: 0,
      totalAttempts: this.config.maxAttempts,
      lastError: null,
      lastRetryTime: 0,
      totalWaitTime: 0,
    };
  }

  /** Get current state */
  getState(): Readonly<RetryState> {
    return { ...this.state };
  }

  /** Calculate delay for current attempt */
  getDelay(attempt: number, retryAfter?: number): number {
    // Use Retry-After header if available and configured
    if (retryAfter && this.config.respectRetryAfter) {
      return Math.min(retryAfter, this.config.maxDelay);
    }

    // Exponential backoff
    const delay = this.config.baseDelay * Math.pow(this.config.backoffMultiplier, attempt);
    return Math.min(delay, this.config.maxDelay);
  }

  /** Check if we should retry */
  shouldRetry(error: unknown): boolean {
    if (this.state.attempt >= this.config.maxAttempts) {
      return false;
    }

    /**
     * 第 84 波（预算核算错误）：原来拿 **累计等待时间**（`totalWaitTime`，只统计 sleep）
     * 和 `totalTimeout` 比较。而真正耗时的大头是每次请求本身（fn 的执行时间）——
     * 于是一次 30 秒的请求 + 5 次重试能跑出远超 "总超时 30 分钟" 的墙钟时间，
     * 用户以为有总超时保护，实际没有。
     *
     * ⚠️ 第 191 波（O-41 / RETRY-BUDGET-2）：**这一支也是"预算用尽"**，同样必须用户可见。
     * 旧形态这里静默返回 false（只有下面那条"等待装不下"的分支会报），
     * 于是"请求本身很慢把预算跑光"这条最常见的路径上，用户什么都看不到。
     */
    if (this.elapsedMs() >= this.config.totalTimeout) {
      this.reportBudgetExhausted(`已耗时 ${Math.round(this.elapsedMs() / 1000)}s ≥ 预算 ${Math.round(this.config.totalTimeout / 60000)} 分钟`, error);
      return false;
    }

    const { isRetryable } = classifyError(error);
    return isRetryable;
  }

  /**
   * O-41 / `RETRY-BUDGET-2`：**预算用尽必须用户可见**（唯一实现，两处出口共用）。
   *
   * 旧形态只有 `console.warn`（渲染侧日志在打包版里用户看不到）⇒ 界面上只剩最后那个
   * provider 错误，用户不知道"我们已经重试了 N 次、把预算用完了"。
   */
  private reportBudgetExhausted(detail: string, lastError: unknown): void {
    reportActionFailure(
      "loop.retryBudget",
      new Error(
        `重试预算已用尽：${detail} —— 不再重试（已重试 ${this.state.attempt} 次，上限 ${this.config.maxAttempts}）`,
      ),
      `最后一次错误：${lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError).slice(0, 200)}`,
      {
        title: "重试预算已用尽",
        consequence:
          "这一回合没有完成（最后一次错误已如实抛出）。可在「设置 → 重试」里调小单次等待或次数，然后重发；" +
          "若 provider 在响应头里给了 Retry-After，等待会以它为准（受单次上限约束）。",
      },
    );
  }

  /** 本次 execute 已消耗的墙钟时间（未开始计时时为 0） */
  private elapsedMs(): number {
    return this.startedAt > 0 ? Date.now() - this.startedAt : 0;
  }

  /** Execute with retry */
  async execute<T>(
    fn: () => Promise<T>,
    onRetry?: (attempt: number, delay: number, error: unknown) => void,
  ): Promise<T> {
    this.reset();
    this.startedAt = Date.now();

    while (true) {
      try {
        return await fn();
      } catch (error) {
        this.state.lastError = error;
        this.state.attempt++;

        if (!this.shouldRetry(error)) {
          throw error;
        }

        const { retryAfter } = classifyError(error);
        const delay = this.getDelay(this.state.attempt - 1, retryAfter);

        // 预算里还要给这次等待留位置：等待完就超预算的话，不如现在就把最后的错误抛出去
        const elapsed = this.elapsedMs();
        if (elapsed + delay > this.config.totalTimeout) {
          this.reportBudgetExhausted(
            `已耗时 ${Math.round(elapsed / 1000)}s + 下次等待 ${Math.round(delay / 1000)}s > 预算 ${Math.round(this.config.totalTimeout / 60000)} 分钟`,
            error,
          );
          console.warn(
            `[Retry] 重试预算已用尽（已耗时 ${elapsed}ms + 下次等待 ${delay}ms > 预算 ${this.config.totalTimeout}ms）—— 不再重试，直接抛出最后一次错误`,
          );
          throw error;
        }

        this.state.totalWaitTime += delay;
        this.state.lastRetryTime = Date.now();

        onRetry?.(this.state.attempt, delay, error);

        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ========== Retry Logger ==========
export function logRetry(attempt: number, delay: number, error: unknown) {
  const { type } = classifyError(error);
  console.warn(
    `[Retry] Attempt ${attempt}, delay ${delay}ms, type: ${type || "unknown"}`,
    error instanceof Error ? error.message : error,
  );
}

// ========== Singleton ==========
let instance: RetryExecutor | null = null;

export function getRetryExecutor(): RetryExecutor {
  if (!instance) {
    instance = new RetryExecutor();
  }
  return instance;
}
