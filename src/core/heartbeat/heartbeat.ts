// ========== Heartbeat Types ==========
export type HeartbeatStatus = "active" | "idle" | "paused" | "stopped";

export interface HeartbeatConfig {
  /** Heartbeat interval in milliseconds */
  interval: number;
  /** Endpoint URL for heartbeats */
  endpoint?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Timeout for heartbeat requests */
  timeout: number;
  /** Whether to send heartbeat data */
  sendMetadata: boolean;
  /** Maximum consecutive failures before stopping */
  maxFailures: number;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  interval: 30000, // 30 seconds
  timeout: 5000,
  sendMetadata: true,
  maxFailures: 3,
};

export interface HeartbeatData {
  /** Session ID */
  sessionId: string;
  /** Current status */
  status: HeartbeatStatus;
  /** Activity type */
  activity: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Current message count */
  messageCount: number;
  /** Current token usage */
  tokenUsage?: number;
  /** Active tool names */
  activeTools?: string[];
  /** Error count */
  errorCount: number;
  /** Timestamp */
  timestamp: number;
}

export interface HeartbeatEvent {
  type: "sent" | "failed" | "stopped" | "resumed" | "error";
  timestamp: number;
  data?: HeartbeatData;
  error?: string;
}

// ========== Activity Heartbeat ==========
export class ActivityHeartbeat {
  private config: HeartbeatConfig;
  private status: HeartbeatStatus = "stopped";
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: HeartbeatData;
  private consecutiveFailures = 0;
  private listeners: Map<string, (event: HeartbeatEvent) => void> = new Map();
  private abortController: AbortController | null = null;

  constructor(sessionId: string, config?: Partial<HeartbeatConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = {
      sessionId,
      status: "stopped",
      activity: "idle",
      messageCount: 0,
      errorCount: 0,
      timestamp: Date.now(),
    };
  }

  /** Start the heartbeat */
  start(): void {
    if (this.timer) return;

    this.status = "active";
    this.data.status = "active";
    this.consecutiveFailures = 0;

    // Send initial heartbeat
    this.sendHeartbeat();

    // Start interval
    this.timer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.interval);

    this.emit({ type: "resumed", timestamp: Date.now() });
  }

  /** Stop the heartbeat */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.status = "stopped";
    this.data.status = "stopped";

    this.emit({ type: "stopped", timestamp: Date.now() });
  }

  /** Pause the heartbeat */
  pause(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.status = "paused";
    this.data.status = "paused";
  }

  /** Resume the heartbeat */
  resume(): void {
    if (this.status === "paused") {
      this.start();
    }
  }

  /** Update activity type */
  setActivity(activity: string): void {
    this.data.activity = activity;
  }

  /** Update progress */
  setProgress(progress: number): void {
    this.data.progress = Math.min(100, Math.max(0, progress));
  }

  /** Update message count */
  setMessageCount(count: number): void {
    this.data.messageCount = count;
  }

  /** Update token usage */
  setTokenUsage(usage: number): void {
    this.data.tokenUsage = usage;
  }

  /** Update active tools */
  setActiveTools(tools: string[]): void {
    this.data.activeTools = tools;
  }

  /** Increment error count */
  incrementErrors(): void {
    this.data.errorCount++;
  }

  /** Get current status */
  getStatus(): HeartbeatStatus {
    return this.status;
  }

  /** Get current data */
  getData(): Readonly<HeartbeatData> {
    return { ...this.data, timestamp: Date.now() };
  }

  /** Send a heartbeat */
  private async sendHeartbeat(): Promise<void> {
    if (!this.config.endpoint) {
      // No endpoint configured, just update timestamp
      this.data.timestamp = Date.now();
      return;
    }

    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, this.config.timeout);

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify({
          ...this.data,
          timestamp: Date.now(),
        }),
        signal: this.abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Heartbeat failed: ${response.status}`);
      }

      this.consecutiveFailures = 0;
      this.emit({ type: "sent", timestamp: Date.now(), data: this.getData() });
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === "AbortError") {
        // Timeout
        this.consecutiveFailures++;
      } else {
        this.consecutiveFailures++;
      }

      this.emit({
        type: "failed",
        timestamp: Date.now(),
        error: error.message,
      });

      // Stop if too many failures
      if (this.consecutiveFailures >= this.config.maxFailures) {
        this.stop();
        this.emit({
          type: "error",
          timestamp: Date.now(),
          error: `Stopped after ${this.config.maxFailures} consecutive failures`,
        });
      }
    }
  }

  /** Subscribe to events */
  on(event: string, listener: (event: HeartbeatEvent) => void): () => void {
    this.listeners.set(event, listener);
    return () => {
      this.listeners.delete(event);
    };
  }

  /** Emit event */
  private emit(event: HeartbeatEvent): void {
    for (const [pattern, listener] of this.listeners) {
      if (event.type === pattern || pattern === "*") {
        listener(event);
      }
    }
  }

  /** Destroy the heartbeat */
  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}

// ========== Heartbeat Manager ==========
export class HeartbeatManager {
  private heartbeats: Map<string, ActivityHeartbeat> = new Map();

  /** Create a heartbeat for a session */
  create(sessionId: string, config?: Partial<HeartbeatConfig>): ActivityHeartbeat {
    const existing = this.heartbeats.get(sessionId);
    if (existing) return existing;

    const heartbeat = new ActivityHeartbeat(sessionId, config);
    this.heartbeats.set(sessionId, heartbeat);
    return heartbeat;
  }

  /** Get a heartbeat */
  get(sessionId: string): ActivityHeartbeat | undefined {
    return this.heartbeats.get(sessionId);
  }

  /** Remove a heartbeat */
  remove(sessionId: string): void {
    const heartbeat = this.heartbeats.get(sessionId);
    if (heartbeat) {
      heartbeat.destroy();
      this.heartbeats.delete(sessionId);
    }
  }

  /** Stop all heartbeats */
  stopAll(): void {
    for (const heartbeat of this.heartbeats.values()) {
      heartbeat.stop();
    }
  }

  /** Get all active heartbeats */
  getActive(): ActivityHeartbeat[] {
    return Array.from(this.heartbeats.values())
      .filter((h) => h.getStatus() === "active");
  }

  /** Get stats */
  getStats(): {
    total: number;
    active: number;
    paused: number;
    stopped: number;
  } {
    const heartbeats = Array.from(this.heartbeats.values());
    return {
      total: heartbeats.length,
      active: heartbeats.filter((h) => h.getStatus() === "active").length,
      paused: heartbeats.filter((h) => h.getStatus() === "paused").length,
      stopped: heartbeats.filter((h) => h.getStatus() === "stopped").length,
    };
  }
}

// ========== Singleton ==========
let managerInstance: HeartbeatManager | null = null;

export function getHeartbeatManager(): HeartbeatManager {
  if (!managerInstance) {
    managerInstance = new HeartbeatManager();
  }
  return managerInstance;
}
