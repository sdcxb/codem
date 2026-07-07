import type { TokenUsage } from "./types";
import { getSettingJSON, setSettingJSON } from "../storage/settings";

// ========== Cost Types ==========
export interface ModelCost {
  modelId: string;
  provider: string;
  inputCostPer1k: number;
  outputCostPer1k: number;
  cacheCostPer1k?: number;
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  timestamp: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
  duration: number; // API call duration in ms
  toolCalls: number;
  success: boolean;
  error?: string;
}

export interface SessionCost {
  sessionId: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDuration: number;
  apiCalls: number;
  toolCalls: number;
  modelBreakdown: Record<string, {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
  }>;
}

export interface CostTrackerConfig {
  /** Storage key */
  storageKey: string;
  /** Maximum records to keep */
  maxRecords: number;
  /** Whether to persist to localStorage */
  persist: boolean;
  /** Cost limits */
  limits: {
    /** Maximum cost per session */
    perSession?: number;
    /** Maximum cost per day */
    perDay?: number;
    /** Maximum total cost */
    total?: number;
  };
}

const DEFAULT_CONFIG: CostTrackerConfig = {
  storageKey: "codem-cost-tracker",
  maxRecords: 10000,
  persist: true,
  limits: {},
};

// ========== Model Cost Database ==========
const MODEL_COSTS: Record<string, ModelCost> = {
  // OpenAI
  "gpt-4o": { modelId: "gpt-4o", provider: "openai", inputCostPer1k: 0.0025, outputCostPer1k: 0.01 },
  "gpt-4o-mini": { modelId: "gpt-4o-mini", provider: "openai", inputCostPer1k: 0.00015, outputCostPer1k: 0.0006 },
  "o3": { modelId: "o3", provider: "openai", inputCostPer1k: 0.01, outputCostPer1k: 0.04 },
  // Anthropic
  "claude-sonnet-4-20250514": { modelId: "claude-sonnet-4-20250514", provider: "anthropic", inputCostPer1k: 0.003, outputCostPer1k: 0.015 },
  "claude-opus-4-20250514": { modelId: "claude-opus-4-20250514", provider: "anthropic", inputCostPer1k: 0.015, outputCostPer1k: 0.075 },
  // MiMo (Xiaomi)
  "mimo-auto": { modelId: "mimo-auto", provider: "mimo", inputCostPer1k: 0.001, outputCostPer1k: 0.002 },
  "mimo-v2.5-pro": { modelId: "mimo-v2.5-pro", provider: "mimo", inputCostPer1k: 0.003, outputCostPer1k: 0.006 },
  "mimo-v2.5": { modelId: "mimo-v2.5", provider: "mimo", inputCostPer1k: 0.002, outputCostPer1k: 0.004 },
  "mimo-v2-pro": { modelId: "mimo-v2-pro", provider: "mimo", inputCostPer1k: 0.002, outputCostPer1k: 0.004 },
  "mimo-v2-flash": { modelId: "mimo-v2-flash", provider: "mimo", inputCostPer1k: 0.0005, outputCostPer1k: 0.001 },
  // DeepSeek
  "deepseek-v4-flash": { modelId: "deepseek-v4-flash", provider: "deepseek", inputCostPer1k: 0.00027, outputCostPer1k: 0.0011 },
  "deepseek-v4-pro": { modelId: "deepseek-v4-pro", provider: "deepseek", inputCostPer1k: 0.0022, outputCostPer1k: 0.0088 },
  "deepseek-chat": { modelId: "deepseek-chat", provider: "deepseek", inputCostPer1k: 0.00027, outputCostPer1k: 0.0011 },
  "deepseek-reasoner": { modelId: "deepseek-reasoner", provider: "deepseek", inputCostPer1k: 0.00055, outputCostPer1k: 0.0022 },
  // Moonshot (Kimi)
  "moonshot-v1-8k": { modelId: "moonshot-v1-8k", provider: "moonshot", inputCostPer1k: 0.0017, outputCostPer1k: 0.0017 },
  "moonshot-v1-32k": { modelId: "moonshot-v1-32k", provider: "moonshot", inputCostPer1k: 0.0034, outputCostPer1k: 0.0034 },
  "moonshot-v1-128k": { modelId: "moonshot-v1-128k", provider: "moonshot", inputCostPer1k: 0.0085, outputCostPer1k: 0.0085 },
  // Google Gemini
  "gemini-2.5-flash": { modelId: "gemini-2.5-flash", provider: "gemini", inputCostPer1k: 0.0003, outputCostPer1k: 0.0025 },
  "gemini-2.5-pro": { modelId: "gemini-2.5-pro", provider: "gemini", inputCostPer1k: 0.00125, outputCostPer1k: 0.005 },
  "gemini-2.0-flash": { modelId: "gemini-2.0-flash", provider: "gemini", inputCostPer1k: 0.0001, outputCostPer1k: 0.0004 },
};

// ========== Cost Tracker ==========
export class CostTracker {
  private config: CostTrackerConfig;
  private records: UsageRecord[] = [];
  private sessionCosts: Map<string, SessionCost> = new Map();

  constructor(config?: Partial<CostTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.persist) {
      this.load();
    }
  }

  /** Load records from SQLite */
  private load() {
    try {
      const parsed = getSettingJSON<any>(this.config.storageKey, null);
      if (parsed) {
        this.records = parsed.records || [];
        this.sessionCosts = new Map(parsed.sessionCosts || []);
      }
    } catch {}
  }

  /** Save records to SQLite */
  private save() {
    if (!this.config.persist) return;

    try {
      // Trim old records
      if (this.records.length > this.config.maxRecords) {
        this.records = this.records.slice(-this.config.maxRecords);
      }

      setSettingJSON(this.config.storageKey, {
        records: this.records,
        sessionCosts: Array.from(this.sessionCosts.entries()),
      });
    } catch {}
  }

  /** Record an API call */
  recordUsage(params: {
    sessionId: string;
    model: string;
    provider: string;
    usage: TokenUsage;
    duration: number;
    toolCalls?: number;
    success?: boolean;
    error?: string;
  }): UsageRecord {
    const cost = this.calculateCost(params.model, params.usage);

    const record: UsageRecord = {
      id: `usage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sessionId: params.sessionId,
      timestamp: Date.now(),
      model: params.model,
      provider: params.provider,
      inputTokens: params.usage.promptTokens,
      outputTokens: params.usage.completionTokens,
      cost,
      duration: params.duration,
      toolCalls: params.toolCalls || 0,
      success: params.success !== false,
      error: params.error,
    };

    this.records.push(record);

    // Update session cost
    this.updateSessionCost(record);

    // Check limits
    this.checkLimits(record);

    this.save();

    return record;
  }

  /** Calculate cost for a model */
  calculateCost(model: string, usage: TokenUsage): number {
    // Try exact match first
    let costInfo = MODEL_COSTS[model];

    // Try prefix match for model variants (e.g. deepseek-chat -> deepseek-chat)
    if (!costInfo) {
      const keys = Object.keys(MODEL_COSTS);
      for (const key of keys) {
        if (model.startsWith(key) || key.startsWith(model.split("-").slice(0, 2).join("-"))) {
          costInfo = MODEL_COSTS[key];
          break;
        }
      }
    }

    if (!costInfo) return 0;

    const inputCost = (usage.promptTokens / 1000) * costInfo.inputCostPer1k;
    const outputCost = (usage.completionTokens / 1000) * costInfo.outputCostPer1k;

    return inputCost + outputCost;
  }

  /** Update session cost */
  private updateSessionCost(record: UsageRecord) {
    let sessionCost = this.sessionCosts.get(record.sessionId);

    if (!sessionCost) {
      sessionCost = {
        sessionId: record.sessionId,
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalDuration: 0,
        apiCalls: 0,
        toolCalls: 0,
        modelBreakdown: {},
      };
      this.sessionCosts.set(record.sessionId, sessionCost);
    }

    sessionCost.totalCost += record.cost;
    sessionCost.totalInputTokens += record.inputTokens;
    sessionCost.totalOutputTokens += record.outputTokens;
    sessionCost.totalDuration += record.duration;
    sessionCost.apiCalls++;
    sessionCost.toolCalls += record.toolCalls;

    // Update model breakdown
    if (!sessionCost.modelBreakdown[record.model]) {
      sessionCost.modelBreakdown[record.model] = {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
      };
    }

    const modelBreakdown = sessionCost.modelBreakdown[record.model];
    modelBreakdown.cost += record.cost;
    modelBreakdown.inputTokens += record.inputTokens;
    modelBreakdown.outputTokens += record.outputTokens;
    modelBreakdown.calls++;
  }

  /** Check cost limits */
  private checkLimits(record: UsageRecord) {
    const { limits } = this.config;

    if (limits.perSession) {
      const sessionCost = this.sessionCosts.get(record.sessionId);
      if (sessionCost && sessionCost.totalCost > limits.perSession) {
        console.warn(`[CostTracker] Session cost limit exceeded: $${sessionCost.totalCost.toFixed(4)} > $${limits.perSession}`);
      }
    }

    if (limits.perDay) {
      const today = new Date().toISOString().split("T")[0];
      const dayCost = this.records
        .filter((r) => new Date(r.timestamp).toISOString().split("T")[0] === today)
        .reduce((sum, r) => sum + r.cost, 0);

      if (dayCost > limits.perDay) {
        console.warn(`[CostTracker] Daily cost limit exceeded: $${dayCost.toFixed(4)} > $${limits.perDay}`);
      }
    }

    if (limits.total) {
      const totalCost = this.records.reduce((sum, r) => sum + r.cost, 0);
      if (totalCost > limits.total) {
        console.warn(`[CostTracker] Total cost limit exceeded: $${totalCost.toFixed(4)} > $${limits.total}`);
      }
    }
  }

  /** Get session cost */
  getSessionCost(sessionId: string): SessionCost | undefined {
    return this.sessionCosts.get(sessionId);
  }

  /** Get all records for a session */
  getSessionRecords(sessionId: string): UsageRecord[] {
    return this.records.filter((r) => r.sessionId === sessionId);
  }

  /** Get records for a time range */
  getRecordsInRange(start: number, end: number): UsageRecord[] {
    return this.records.filter((r) => r.timestamp >= start && r.timestamp <= end);
  }

  /** Get total cost */
  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.cost, 0);
  }

  /** Get cost for today */
  getTodayCost(): number {
    const today = new Date().toISOString().split("T")[0];
    return this.records
      .filter((r) => new Date(r.timestamp).toISOString().split("T")[0] === today)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  /** Get cost breakdown by model */
  getCostByModel(): Record<string, number> {
    const breakdown: Record<string, number> = {};
    for (const record of this.records) {
      breakdown[record.model] = (breakdown[record.model] || 0) + record.cost;
    }
    return breakdown;
  }

  /** Get stats */
  getStats(): {
    totalRecords: number;
    totalCost: number;
    todayCost: number;
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDuration: number;
    averageCostPerCall: number;
    averageDuration: number;
  } {
    const totalCost = this.getTotalCost();
    const totalSessions = new Set(this.records.map((r) => r.sessionId)).size;
    const totalInputTokens = this.records.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalOutputTokens = this.records.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalDuration = this.records.reduce((sum, r) => sum + r.duration, 0);

    return {
      totalRecords: this.records.length,
      totalCost,
      todayCost: this.getTodayCost(),
      totalSessions,
      totalInputTokens,
      totalOutputTokens,
      totalDuration,
      averageCostPerCall: this.records.length > 0 ? totalCost / this.records.length : 0,
      averageDuration: this.records.length > 0 ? totalDuration / this.records.length : 0,
    };
  }

  /** Clear all records */
  clear() {
    this.records = [];
    this.sessionCosts.clear();
    this.save();
  }

  /** Export records */
  exportRecords(): string {
    return JSON.stringify(this.records, null, 2);
  }

  /** Import records */
  importRecords(json: string): boolean {
    try {
      const imported = JSON.parse(json);
      if (!Array.isArray(imported)) return false;
      this.records = imported;
      this.save();
      return true;
    } catch {
      return false;
    }
  }

  /** Format cost for display */
  static formatCost(cost: number): string {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  }

  /** Format tokens for display */
  static formatTokens(tokens: number): string {
    if (tokens < 1000) return `${tokens}`;
    if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
    return `${(tokens / 1000000).toFixed(1)}M`;
  }

  /** Format duration for display */
  static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }
}

// ========== Singleton ==========
let instance: CostTracker | null = null;

export function getCostTracker(): CostTracker {
  if (!instance) {
    instance = new CostTracker();
  }
  return instance;
}
