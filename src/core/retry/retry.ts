// ========== Error Types ==========
import { setSettingJSON } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";

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
  /pending stream has been canceled/i, // HTTP/2 请求发出前连接就没了（Pi #10379）
  /http2 request did not get a response/i,
  /stream (ended|closed) before/i,
  /connection (reset|closed) by peer/i,
  /\bplease retry\b|\btry again later\b/i,
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
     */
    if (this.elapsedMs() >= this.config.totalTimeout) {
      return false;
    }

    const { isRetryable } = classifyError(error);
    return isRetryable;
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
