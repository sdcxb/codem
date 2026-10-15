import type { MessageV2 } from "../llm/session";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";
/**
 * 第 184 波（G6）：**唯一一份 token 估算真值**（CJK 感知）。
 *
 * 直接从 `llm/token-tracker` 取，不再在本文件里另写一个 `chars / 4`
 * —— 两份估算器并存正是这一波要修的缺陷（中文压力被低报约 2.4×）。
 */
import { estimateTokens as estimateTokensCjkAware } from "../llm/token-tracker";

// ========== 压力等级（**唯一一份阈值**）==========

/**
 * 压力等级的阈值（占用率 → 等级 0..3）。
 *
 * ## 为什么单独抽出来（第 72 轮真机走查抓到的问题）
 *
 * 上下文面板上**同时**显示两样东西：占用率（`23,678 / 115,200 tokens 21%`）与
 * 「压力等级」。真机实测两者**互相矛盾**：屏幕上写着 21%，紧跟着却是
 * 「压力等级：临界」+「🔴 上下文即将满！请立即压缩或开启新对话」。
 *
 * 根因是**同一件事被两套口径各算一遍**：
 * - 占用率用的是"模型这次真的会收到多少"（可见消息 → 裁剪陈旧工具结果 →
 *   按优先级选进"真实窗口 × 0.9"的预算，`summarizeModelContext`）；
 * - 压力等级却调用 `getPressureLevelFromMessages(可见消息)`，
 *   它自己另算一遍 `available = maxContextWindow − systemPrompt − outputReserve`
 *   且**不做裁剪与优先级选择** —— 分子分母都不同。
 *
 * 这与第 71 轮"概览卡与委派页签同一事实两个答案"是**同一个病**：口径不能写两遍。
 * 所以这里把阈值收成唯一实现，并新增 `summarizeDisplayPressure`：
 * **面板上那两个数字必须从同一对分子/分母导出**。
 */
export const PRESSURE_THRESHOLDS = [0.5, 0.7, 0.9] as const;

/** 占用率 → 压力等级（0 正常 / 1 中等 / 2 较高 / 3 临界）。
 *
 * 退化输入的取向（用例 `CMP-1` 钉住）：
 * - `NaN` / 负数 / `-Infinity` → **0**（"算不出来"不等于"快满了"，不许虚报告警）；
 * - `+Infinity` → **3**（used 远大于 available 是真的满）。
 */
export function pressureLevelForRatio(ratio: number): number {
  if (Number.isNaN(ratio) || ratio <= 0) return 0;
  if (ratio < PRESSURE_THRESHOLDS[0]) return 0;
  if (ratio < PRESSURE_THRESHOLDS[1]) return 1;
  if (ratio < PRESSURE_THRESHOLDS[2]) return 2;
  return 3;
}

/**
 * 面板显示用的一对数字：**百分比与压力等级必须自洽**。
 *
 * 这是"同一事实只有一份口径"的落点：调用方（`ContextMonitor`）传进来的
 * `used` / `available` 就是它**画进度条用的那两个数**，等级由同一个比值导出，
 * 于是"21% 却显示临界"这类矛盾从构造上不可能再出现。
 */
export function summarizeDisplayPressure(
  used: number,
  available: number,
): { ratio: number; percent: number; level: number } {
  const ratio = available > 0 && Number.isFinite(used) ? used / available : 0;
  return { ratio, percent: Math.round(Math.max(0, ratio) * 100), level: pressureLevelForRatio(ratio) };
}

// ========== Token Budget ==========
export interface TokenBudget {
  /** Total context window size */
  total: number;
  /** Reserved for system prompt */
  systemPrompt: number;
  /** Reserved for output */
  outputReserve: number;
  /** Available for messages */
  available: number;
  /** Current usage */
  used: number;
  /** Remaining */
  remaining: number;
}

export interface CompactionConfig {
  /** Maximum context window size */
  maxContextWindow: number;
  /** Reserved tokens for output */
  outputReserve: number;
  /** System prompt token estimate */
  systemPromptTokens: number;
  /** Pressure threshold to trigger compaction (0-1) */
  compactionThreshold: number;
  /** Maximum messages to keep after compaction */
  maxMessagesAfterCompaction: number;
  /** Whether to preserve recent tool outputs */
  preserveRecentToolOutputs: boolean;
}

const DEFAULT_CONFIG: CompactionConfig = {
  maxContextWindow: 128000,
  outputReserve: 4096,
  systemPromptTokens: 2000,
  compactionThreshold: 0.8,
  maxMessagesAfterCompaction: 20,
  preserveRecentToolOutputs: true,
};

// ========== Context Manager ==========
export class ContextManager {
  private config: CompactionConfig;
  /** ★ 全量审计（真机缺陷②）：是否已成功从存储读到过配置（成功一次即停，避免反复回读） */
  private loadedFromStorage = false;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Calculate token budget for current messages (simple Message format) */
  calculateBudgetFromMessages(messages: { content?: string; reasoning?: string; toolCalls?: Array<{ args?: any; result?: string }> }[]): TokenBudget {
    const used = messages.reduce((sum, msg) => {
      let tokens = 0;
      if (msg.content) tokens += this.estimateTextTokens(msg.content);
      if (msg.reasoning) tokens += this.estimateTextTokens(msg.reasoning);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          tokens += 10;
          if (tc.args) tokens += this.estimateTextTokens(JSON.stringify(tc.args));
          if (tc.result) tokens += this.estimateTextTokens(tc.result);
        }
      }
      return sum + tokens;
    }, 0);
    const available = this.config.maxContextWindow - this.config.systemPromptTokens - this.config.outputReserve;
    return {
      total: this.config.maxContextWindow,
      systemPrompt: this.config.systemPromptTokens,
      outputReserve: this.config.outputReserve,
      available,
      used,
      remaining: Math.max(0, available - used),
    };
  }

  /** Get pressure level from simple Messages (0-3) */
  getPressureLevelFromMessages(messages: { content?: string; reasoning?: string; toolCalls?: Array<{ args?: any; result?: string }> }[]): number {
    const budget = this.calculateBudgetFromMessages(messages);
    return pressureLevelForRatio(budget.available > 0 ? budget.used / budget.available : 0);
  }

  /** Calculate token budget for current messages */
  calculateBudget(messages: MessageV2[]): TokenBudget {
    const used = this.estimateTokens(messages);
    const available = this.config.maxContextWindow - this.config.systemPromptTokens - this.config.outputReserve;

    return {
      total: this.config.maxContextWindow,
      systemPrompt: this.config.systemPromptTokens,
      outputReserve: this.config.outputReserve,
      available,
      used,
      remaining: Math.max(0, available - used),
    };
  }

  /**
   * Check if compaction is needed
   *
   * ★ 全量审计（第三轮）：**这里的口径与引擎实际触发压缩的口径不同**，不要当成同一件事 ——
   *  - 引擎（`AgenticLoop`，真正决定压缩的那条）：`contextPressure > compactionThreshold`（严格大于），
   *    分母是**上下文窗口**，阈值来自 `codem-context-config`（钳制 (0.1, 0.95]）；
   *  - 这里：`used >= compactionThreshold`（大于等于），分母是
   *    `available = maxContextWindow − systemPromptTokens − outputReserve`（扣掉系统提示与输出预留）。
   *  两者读的是**同一个配置键**，但分母与比较符都不同 ⇒ 同一个阈值会得出不同结论。
   *  该方法目前只经 `@codem/compaction` 插件对外暴露（引擎不用它）；若将来要它做触发判定，
   *  必须先统一口径（否则又是一处「同名不同义」）。
   */
  needsCompaction(messages: MessageV2[]): boolean {
    const budget = this.calculateBudget(messages);
    const usageRatio = budget.used / budget.available;
    return usageRatio >= this.config.compactionThreshold;
  }

  /** Get pressure level (0-3) */
  getPressureLevel(messages: MessageV2[]): number {
    const budget = this.calculateBudget(messages);
    const usageRatio = budget.used / budget.available;

    if (usageRatio < 0.5) return 0; // Low
    if (usageRatio < 0.7) return 1; // Medium
    if (usageRatio < 0.9) return 2; // High
    return 3; // Critical
  }

  /** Compact messages to fit within budget.
   *  Strategy: Remove old messages, keep recent ones.
   *  Also trim large tool outputs in the kept messages if needed.
   *  Returns [compactionMarker, ...messagesToKeep].
   */
  compact(messages: MessageV2[]): MessageV2[] {
    if (!this.needsCompaction(messages)) return messages;

    const budget = this.calculateBudget(messages);
    const excessTokens = budget.used - budget.available;

    if (excessTokens <= 0) return messages;

    // Keep the last N messages (make a shallow copy so we can mutate)
    const keepCount = Math.min(this.config.maxMessagesAfterCompaction, messages.length);
    const messagesToKeep = messages.slice(-keepCount).map(m => ({ ...m, parts: [...m.parts] }));
    const messagesToRemove = messages.slice(0, messages.length - keepCount);

    let savedTokens = 0;

    // Calculate tokens saved from removed messages
    for (const msg of messagesToRemove) {
      savedTokens += this.estimateMessageTokens(msg);
    }

    // If still need more space, trim large tool outputs in the kept messages
    if (savedTokens < excessTokens && this.config.preserveRecentToolOutputs) {
      for (let i = 0; i < messagesToKeep.length; i++) {
        const msg = messagesToKeep[i];
        if (msg.role === "assistant") {
          for (const part of msg.parts) {
            if (part.type === "tool" && part.output && part.output.length > 500) {
              const original = part.output;
              part.output = original.substring(0, 500) + "\n...(truncated)";
              savedTokens += this.estimateTextTokens(original) - this.estimateTextTokens(part.output);
            }
          }
        }
      }
    }

    // Add a compaction marker that summarizes what was removed
    const marker: MessageV2 = {
      id: `compact-${Date.now()}`,
      role: "user",
      parts: [{
        type: "text",
        content: `[上下文已压缩：移除了 ${messagesToRemove.length} 条旧消息，节省约 ${savedTokens} tokens。以下是最近 ${keepCount} 条消息，请基于此继续工作。]`,
      }],
      timestamp: Date.now(),
    };

    return [marker, ...messagesToKeep];
  }

  /** Estimate tokens for a message (rough: 1 token ≈ 4 chars) */
  estimateMessageTokens(msg: MessageV2): number {
    let tokens = 0;
    for (const part of msg.parts) {
      if (part.type === "text") {
        tokens += this.estimateTextTokens(part.content);
      } else if (part.type === "tool") {
        tokens += 10; // Base tokens for tool metadata
        tokens += this.estimateTextTokens(part.name);
        tokens += this.estimateTextTokens(JSON.stringify(part.input));
        if (part.output) {
          tokens += this.estimateTextTokens(part.output);
        }
      } else if (part.type === "reasoning") {
        tokens += this.estimateTextTokens(part.content);
      }
    }
    return tokens;
  }

  /**
   * Estimate tokens for text.
   *
   * ★ 第 184 波（G6）：**改用 CJK 感知的估算器**，不再用朴素的 `chars / 4`。
   *
   * ## 缺陷形态（实测）
   *
   * 本类原来用 `Math.ceil(text.length / 4)`。而本仓库**早就有**一份更准的估算器
   * （`llm/token-tracker.ts` 的 `estimateTokens`：CJK ≈ 0.6 token/字符、拉丁 0.25、
   * 数字 0.33、空白/标点 0.5），并且**主路径已经在用它**（`agentic-loop.ts` 的
   * `estimatePressure`）。两条路径口径不同，后果是：
   *
   *  · **中文会话的上下文压力被低报约 2.4×** —— 1000 个汉字按 `chars/4` 是 250 token，
   *    按 CJK 感知是 600 token。于是界面显示"还很空"而实际已接近上限；
   *  · 走本类的那条**插件压缩路径**（`compaction-provider` 的 `shouldCompact`）会**太晚**触发。
   *
   * 现在两份口径合一：本方法直接委托 `token-tracker.estimateTokens`。
   * 这样"界面上看到的压力"与"循环里判定的压力"必然是同一个数（否则又是一类双口径缺陷）。
   */
  estimateTextTokens(text: string): number {
    return estimateTokensCjkAware(text);
  }

  /** Estimate total tokens for all messages */
  estimateTokens(messages: MessageV2[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
  }

  /** Get a summary of token usage */
  getUsageSummary(messages: MessageV2[]): {
    totalTokens: number;
    messageCount: number;
    toolCallCount: number;
    avgTokensPerMessage: number;
    largestMessage: { id: string; tokens: number } | null;
  } {
    let totalTokens = 0;
    let toolCallCount = 0;
    let largest: { id: string; tokens: number } | null = null;

    for (const msg of messages) {
      const tokens = this.estimateMessageTokens(msg);
      totalTokens += tokens;

      if (!largest || tokens > largest.tokens) {
        largest = { id: msg.id, tokens };
      }

      for (const part of msg.parts) {
        if (part.type === "tool") toolCallCount++;
      }
    }

    return {
      totalTokens,
      messageCount: messages.length,
      toolCallCount,
      avgTokensPerMessage: messages.length > 0 ? Math.round(totalTokens / messages.length) : 0,
      largestMessage: largest,
    };
  }

  /**
   * Update config and persist
   *
   * ★ 全量审计（真机缺陷②）：落盘失败**不许被吞** —— 原来这里是 `try { … } catch {}`，
   * 于是「保存没成功」在界面上长得和「保存成功」一模一样（本仓 `audit:false-success` 要抓的形状）。
   */
  updateConfig(config: Partial<CompactionConfig>) {
    this.config = { ...this.config, ...config };
    /* 我们自己写进去的值就是当前真相 ⇒ 标记已加载，后续 getConfig() 不必再回读（避免读到旧盘值覆盖内存新值） */
    this.loadedFromStorage = true;
    try {
      setSettingJSON("codem-context-config", this.config);
    } catch (e) {
      reportPersistFailure("context.updateConfig", e, "上下文配置未保存（重启后会回到上一次的值）");
    }
  }

  /**
   * ★ 全量审计（真机缺陷②）：存储就绪后**重读一次**已保存的配置。
   *
   * 被守的缺陷（1.16.319 真机形态）：单例的首次构造常常发生在**存储端口预热之前**
   * （`getSetting` 那时返回 null 并留痕），于是配置退回默认值（0.8）且此后**永不重读** ——
   * 用户在设置里把阈值改成 0.5、写盘也成功了（设置表里确实是 0.5），
   * 但面板与引擎永远按 0.8 走（真机实测：重载后面板仍显示 80%）。
   *
   * 读法：只在**还没成功读到过**时回读（成功一次即停），读不到不算错（端口可能仍未就绪）。
   */
  refreshFromStorage(): boolean {
    if (this.loadedFromStorage) return false;
    try {
      const saved = getSettingJSON<Partial<CompactionConfig> | null>("codem-context-config", null);
      if (saved && typeof saved === "object") {
        this.config = { ...this.config, ...(saved as Partial<CompactionConfig>) };
        this.loadedFromStorage = true;
        return true;
      }
    } catch (e) {
      /* 读失败要如实上报（但不是致命：本次仍可用默认值继续） */
      reportPersistFailure("context.refreshFromStorage", e, "上下文配置没能从设置里读出来（本次用默认值）");
    }
    return false;
  }

  /** Get current config（★ 真机缺陷②：每次取用时都尝试补读一次，直到成功） */
  getConfig(): CompactionConfig {
    this.refreshFromStorage();
    return { ...this.config };
  }

  /** ★ 全量审计：是否已经成功从存储读到过配置（判据用） */
  isLoadedFromStorage(): boolean {
    return this.loadedFromStorage;
  }
}

// ========== Singleton ==========
let instance: ContextManager | null = null;

export function getContextManager(): ContextManager {
  if (!instance) {
    instance = new ContextManager();
    /*
     * ★ 全量审计（真机缺陷②）：构造时读一次**只是尽力而为** —— 那一刻端口常常还没预热，
     * `getSetting` 会返回 null。真正的保证在 `refreshFromStorage()`：它会在端口就绪后补读，
     * 并且 `getConfig()` 每次取用都会再试一次，直到成功一次为止。
     * （这里也不再吞异常：读不出来要有痕迹，见 refreshFromStorage 内的上报。）
     */
    instance.refreshFromStorage();
  }
  return instance;
}
