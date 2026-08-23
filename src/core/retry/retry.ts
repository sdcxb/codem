// ========== Error Types ==========
import { setSettingJSON } from "../storage/settings";

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

    if (status >= 500 && status < 600) {
      return { type: "server_error", isRetryable: true };
    }

    if (status === 529) {
      return { type: "capacity", isRetryable: true };
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
    } catch (e) { console.warn('[retry.ts]', e) }
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

    const totalWait = this.state.totalWaitTime;
    if (totalWait >= this.config.totalTimeout) {
      return false;
    }

    const { isRetryable } = classifyError(error);
    return isRetryable;
  }

  /** Execute with retry */
  async execute<T>(
    fn: () => Promise<T>,
    onRetry?: (attempt: number, delay: number, error: unknown) => void,
  ): Promise<T> {
    this.reset();

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
