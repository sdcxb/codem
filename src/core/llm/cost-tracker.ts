import type { TokenUsage } from "./types";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { getTelemetry } from "../telemetry/telemetry";
import { reportPersistFailure } from "../storage/persist-failure";

// ========== Cost Types ==========
/**
 * 单个模型的计价率。
 *
 * ★ 第 184 波（G4）：新增 **`tiers`（提示长度分档定价）**，对标 Pi v1.1.0 的
 * `ModelCostTier { inputTokensAbove }`（`ai/src/models.ts:1200-1209`）。
 *
 * ## 缺陷形态（改前）
 *
 * 只有一组平费率 ⇒ 像 Claude Haiku 5.5、Gemini 3.1 Pro 这类"**超过 100k 输入后整个请求
 * 按更高档计费**"的模型会被**系统性少算**（上游的注释原话：
 * "Prompts over 100k input tokens are billed at 5x for the whole request"）。
 *
 * ## 口径（与上游逐条对齐）
 *
 * · 档位判据是**该请求的输入总量**（未命中输入 + 缓存命中输入 + 缓存写入）；
 * · 命中的是**最高的那个满足 `inputTokensAbove` 的档**；
 * · 该档费率适用于**整个请求**（不是分段累进）；
 * · 没有 `tiers` 或都不满足 ⇒ 退回平费率。
 */
export interface ModelCost {
  modelId: string;
  provider: string;
  inputCostPer1k: number;
  outputCostPer1k: number;
  cacheCostPer1k?: number;
  /** 分档费率：命中"输入总量 > inputTokensAbove"的**最高**档（请求级，不分段） */
  tiers?: Array<{
    inputTokensAbove: number;
    inputCostPer1k: number;
    outputCostPer1k: number;
    cacheCostPer1k?: number;
  }>;
}

/**
 * ★ 第 184 波（G4）：**按输入总量挑费率档**（纯函数，便于直接判据）。
 *
 * 口径与上游 Pi `calculateCost`（`ai/src/models.ts:1200-1209`）逐条对齐：
 * · 判据是**该请求的输入总量**（未命中输入 + 缓存命中输入）；
 * · 取"输入总量 > `inputTokensAbove`"的**最高档**；
 * · 该档费率适用于**整个请求**（不是分段累进）；
 * · 没有档位或都不满足 ⇒ 退回平费率。
 *
 * 抽成纯函数是为了让判据能**直接喂合成的 `ModelCost`** —— 我们**不往产品数据里编价格**
 * （编错价格比"标成未知"更糟：界面会显示一个自信的错数）。
 */
export function pickCostRates(
  costInfo: ModelCost,
  totalInputTokens: number,
): { inputCostPer1k: number; outputCostPer1k: number; cacheCostPer1k?: number } {
  if (!costInfo.tiers || costInfo.tiers.length === 0) return costInfo;
  const matched = [...costInfo.tiers]
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)
    .find((t) => totalInputTokens > t.inputTokensAbove);
  return matched ?? costInfo;
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
  /**
   * ★ 第 184 波（G4）：这个模型**没有价目** —— `cost` 里的 0 是「不知道」，不是「免费」。
   *
   * 为什么要有这个字段：改前表外模型只留一个 0，界面上看起来免费、
   * `checkLimits`（默认 $5/会话、$20/天）也永远不触发 ⇒ 成本闸门形同虚设。
   * 现在「未知」是一件**可被判据与界面读到的事实**（数字仍然不编）。
   */
  costUnknown?: boolean;
}

export interface SessionCost {
  sessionId: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDuration: number;
  apiCalls: number;
  toolCalls: number;
  /**
   * 第 184 波（G4）：费用**未知**的调用次数（表外模型）。
   *
   * 为什么必须单独计数：`totalCost` 对这些调用只累加 0，于是 `checkLimits`
   * （默认 $5/会话、$20/天）在这些调用上**不可能触发** —— 用户看到"花得很少"，
   * 而真相是"有一部分算不出来"。有了这个计数，界面/日志才能如实说
   * 「本会话有 N 次调用的费用未知，成本上限可能未生效」。
   */
  uncostedCalls: number;
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
  /**
   * Cost limits.
   *
   * ## 为什么三个字段都可以是 `null`（第 45 轮，设置审计 D-12 的另一半）
   *
   * "清空输入框"在设置页里的语义是**不限**。原来的类型是 `number | undefined`，
   * 而 `undefined` 的自有属性会被 `JSON.stringify` **丢掉** —— 于是落库对象里根本没有这个键，
   * 重启时与默认值 merge（`{...DEFAULT_CONFIG.limits, ...saved}`）→ **$5 上限复活**，
   * 而界面刚刚显示过"已保存"。
   *
   * `null` 是 JSON 里能表达的"显式无值"：它会被序列化、会被这里的 merge 保留，
   * 而所有消费方（`checkLimits` / 用量面板）本来就是**真值判断**，`null` 正好等于"不限"。
   * 所以类型必须诚实地说出这件事 —— 否则设置页写 `null` 时只能靠 `as any` 绕过类型系统，
   * 那正是这条缺陷能长期隐身的原因。
   */
  limits: {
    /** Maximum cost per session（`null` = 不限） */
    perSession?: number | null;
    /** Maximum cost per day（`null` = 不限） */
    perDay?: number | null;
    /** Maximum total cost（`null` = 不限） */
    total?: number | null;
  };
}

const DEFAULT_CONFIG: CostTrackerConfig = {
  storageKey: "codem-cost-tracker",
  maxRecords: 10000,
  persist: true,
  limits: {
    // E8: Default cost limits — degrade at 80%, stop at 100%
    perSession: 5.0,  // $5 per session — degrade to cheaper model at $4
    perDay: 20.0,     // $20 per day
  },
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
  "deepseek-v4-flash": { modelId: "deepseek-v4-flash", provider: "deepseek", inputCostPer1k: 0.00027, outputCostPer1k: 0.0011, cacheCostPer1k: 0.00007 },
  "deepseek-v4-pro": { modelId: "deepseek-v4-pro", provider: "deepseek", inputCostPer1k: 0.0022, outputCostPer1k: 0.0088, cacheCostPer1k: 0.0002 },
  "deepseek-chat": { modelId: "deepseek-chat", provider: "deepseek", inputCostPer1k: 0.00027, outputCostPer1k: 0.0011, cacheCostPer1k: 0.00007 },
  "deepseek-reasoner": { modelId: "deepseek-reasoner", provider: "deepseek", inputCostPer1k: 0.00055, outputCostPer1k: 0.0022, cacheCostPer1k: 0.00014 },
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
  /** 第 184 波（G4）：见过的**无价目**模型（价格未知 ≠ 成本为 0） */
  private uncostedModels = new Set<string>();
  private sessionCosts: Map<string, SessionCost> = new Map();

  constructor(config?: Partial<CostTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Load persisted limits
    try {
      const savedLimits = getSettingJSON<any>("codem-cost-limits", null);
      if (savedLimits) {
        this.config.limits = { ...this.config.limits, ...savedLimits };
      }
    } catch (e) { console.warn('[cost-tracker.ts]', e) }
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
        /**
         * ★ 第 184 波（G4）：**旧数据没有 `uncostedCalls`**（这个字段是本波新增的）——
         * 从 localStorage 恢复时必须补 0，否则 `undefined++` 会变成 `NaN`，
         * 而 NaN 会一路污染"本会话费用未知的调用次数"这个读数（界面上显示 NaN）。
         * 这类"新增必填字段 + 反序列化旧数据"的组合是本仓库踩过的坑，
         * 所以补默认值这一步在这里显式做，并有判据（COST-MIG-1）。
         */
        const restored = (parsed.sessionCosts || []) as Array<[string, any]>;
        this.sessionCosts = new Map(
          restored.map(([id, value]) => [id, { ...value, uncostedCalls: Number(value?.uncostedCalls) || 0 }]),
        );
      }
    } catch (e) { console.warn('[cost-tracker.ts]', e) }
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
    } catch (e) { console.warn('[cost-tracker.ts]', e) }
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
      ...(params.usage.cacheHitTokens !== undefined
        ? { cacheReadTokens: params.usage.cacheHitTokens }
        : {}),
      cost,
      duration: params.duration,
      toolCalls: params.toolCalls || 0,
      success: params.success !== false,
      error: params.error,
    };

    /** 第 184 波（G4）：表外模型必须**显式标记**，不许让 0 被读成「免费」 */
    if (!this.isCostKnown(params.model)) {
      (record as UsageRecord & { costUnknown?: boolean }).costUnknown = true;
    }

    this.records.push(record);

    // R3-Audit C2: Forward to TelemetryCollector for unified logging
    // This eliminates the dual-track recording problem — CostTracker is the
    // source of truth for cost, TelemetryCollector receives a forwarded copy.
    try {
      const telemetry = getTelemetry();
      telemetry.record(params.sessionId, "cost_tracked", {
        recordId: record.id,
        model: record.model,
        cost: record.cost,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      });
    } catch {
      // Telemetry not available — non-critical
    }

    // Update session cost
    this.updateSessionCost(record);

    // Check limits
    this.checkLimits(record);

    this.save();

    return record;
  }

  /**
   * Calculate cost for a model.
   *
   * ★ 第 184 波（G4）：
   * · **支持提示长度分档**（见 `ModelCost.tiers`）——档位判据是"该请求的输入总量"，
   *   命中的最高档费率适用于整个请求；
   * · 表外模型**仍然返回 0**（我们**不编价格**），但调用方必须用 `isCostKnown()`
   *   区分"真的是 0 成本"与"我们不知道价格" —— 见 `recordUsage` 里的 `costUnknown`。
   */
  calculateCost(model: string, usage: TokenUsage): number {
    const costInfo = this.resolveCostInfo(model);
    if (!costInfo) return 0;

    // 缓存计价：未命中输入按 inputCostPer1k，命中输入按 cacheCostPer1k
    // （DeepSeek 缓存命中输入显著更便宜——成本精确性对标 dsh billed input 口径）
    const uncachedInput = Math.max(0, usage.promptTokens - (usage.cacheHitTokens ?? 0));
    const cacheRead = usage.cacheHitTokens ?? 0;
    const totalInput = uncachedInput + cacheRead;

    /**
     * 分档（请求级）：取**输入总量**满足的最高档。见 `pickCostRates` 的注释与判据。
     */
    const rates = pickCostRates(costInfo, totalInput);

    const cacheRate = rates.cacheCostPer1k ?? rates.inputCostPer1k;
    const inputCost =
      (uncachedInput / 1000) * rates.inputCostPer1k +
      (cacheRead / 1000) * cacheRate;
    const outputCost = (usage.completionTokens / 1000) * rates.outputCostPer1k;

    return inputCost + outputCost;
  }

  /** 解析模型对应的计价率（含前缀匹配）；表外返回 null */
  private resolveCostInfo(model: string): ModelCost | null {
    const exact = MODEL_COSTS[model];
    if (exact) return exact;
    // Try prefix match for model variants (e.g. deepseek-chat -> deepseek-chat)
    const keys = Object.keys(MODEL_COSTS);
    for (const key of keys) {
      if (model.startsWith(key) || key.startsWith(model.split("-").slice(0, 2).join("-"))) {
        return MODEL_COSTS[key];
      }
    }
    return null;
  }

  /**
   * ★ 第 184 波（G4）：**这个模型的价格我们到底知不知道**。
   *
   * 为什么必须有这个判据：改前表外模型 `calculateCost` 返回 `0`，于是
   * · 用量面板显示 **$0**（看起来"免费"）；
   * · `checkLimits`（默认 $5/会话、$20/天）**永远不触发** ⇒ 成本闸门形同虚设。
   *
   * 数字仍然是 0（我们不编价格），但"未知"这个事实必须**可被判据与界面读到**。
   * 见过的表外模型会记进 `uncostedModels`，供一次性提醒与诊断使用。
   */
  isCostKnown(model: string): boolean {
    const known = this.resolveCostInfo(model) !== null;
    if (!known && model) this.uncostedModels.add(model);
    return known;
  }

  /** 至今见过的**无价目**模型（诊断/提醒用；去重） */
  getUncostedModels(): string[] {
    return [...this.uncostedModels];
  }

  /** 清空"见过无价目模型"的记录（测试用） */
  clearUncostedModels(): void {
    this.uncostedModels.clear();
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
        uncostedCalls: 0,
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
    // 第 184 波（G4）：费用未知的调用要计数 —— 它让"上限可能未生效"变成可读事实
    if (record.costUnknown) sessionCost.uncostedCalls++;

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

  /**
   * Aggregate cost across multiple sessions (e.g., all squad member sessions).
   * Returns total cost and token usage for the given session IDs.
   */
  getSquadCost(sessionIds: string[]): { totalCost: number; totalInputTokens: number; totalOutputTokens: number; apiCalls: number } {
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let apiCalls = 0;
    for (const sid of sessionIds) {
      const sc = this.sessionCosts.get(sid);
      if (sc) {
        totalCost += sc.totalCost;
        totalInputTokens += sc.totalInputTokens;
        totalOutputTokens += sc.totalOutputTokens;
        apiCalls += sc.apiCalls;
      }
    }
    return { totalCost, totalInputTokens, totalOutputTokens, apiCalls };
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
    /**
     * ★ 第 184 波（G4）：**费用未知**的调用次数。
     *
     * 为什么必须有消费方：这个数字存在的唯一意义就是"让用户知道账单可能少算了"。
     * 只写不读等于没做（本波刚修的 G3 就是同一类错：写了 `metadata.duration` 没人读）。
     * 消费方：`UsageStats.tsx` 在总费用旁边显示一行提示。
     */
    uncostedCalls: number;
  } {
    const totalCost = this.getTotalCost();
    const totalSessions = new Set(this.records.map((r) => r.sessionId)).size;
    const totalInputTokens = this.records.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalOutputTokens = this.records.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalDuration = this.records.reduce((sum, r) => sum + r.duration, 0);

    /**
     * ★ 第 185 波（复审 I-7）：**与 `SessionCost.uncostedCalls` 同源（累加值）**。
     *
     * 改前这里从 `this.records` 现算，而 `records` 会被裁到 `maxRecords`（`:236-243`），
     * 另一个来源（`_applyToSession` 里的 `sessionCost.uncostedCalls++`）在
     * `sessionCosts` 上**不裁剪** ⇒ 长期使用后这两个数必然分叉，且这里那个**偏小**
     * （"少算了多少次"变得不保守 —— 恰恰废掉了这个字段存在的意义：让用户知道
     * 账单可能被低估）。
     *
     * 选**累加值**而不是 `records` 的理由：
     * · 唯一消费方（`UsageStats.tsx:146`）是**保守警告**，不是历史窗口内的精确统计；
     * · `sessionCosts` 本来就是"全量落库"的聚合（`records` 只是有界历史窗口）——
     *   拿窗口去算"一共少算了多少次"用的是错的集合；
     * · 顺带消灭第二份计算（一处累加、一处读，不留两条会漂移的路径）。
     */
    const uncostedCalls = Array.from(this.sessionCosts.values()).reduce(
      (sum, s) => sum + (Number(s.uncostedCalls) || 0),
      0,
    );

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
      uncostedCalls,
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

  /** Get current cost limits config */
  getLimits(): CostTrackerConfig["limits"] {
    return { ...this.config.limits };
  }

  /** Update cost limits and persist */
  setLimits(limits: Partial<CostTrackerConfig["limits"]>): void {
    this.config.limits = { ...this.config.limits, ...limits };
    // Persist limits separately so they survive restarts
    try {
      setSettingJSON("codem-cost-limits", this.config.limits);
    } catch (e) { reportPersistFailure("costTracker.setLimits", e, "成本上限设置未保存，重启后会回到旧值"); }
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

