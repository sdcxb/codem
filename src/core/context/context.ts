import type { MessageV2 } from "../llm/session";

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

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

  /** Check if compaction is needed */
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

  /** Compact messages to fit within budget */
  compact(messages: MessageV2[]): MessageV2[] {
    if (!this.needsCompaction(messages)) return messages;

    const budget = this.calculateBudget(messages);
    const excessTokens = budget.used - budget.available;

    if (excessTokens <= 0) return messages;

    // Strategy: Remove old messages, keep recent ones
    const compacted: MessageV2[] = [];
    let savedTokens = 0;

    // Keep the last N messages
    const keepCount = Math.min(this.config.maxMessagesAfterCompaction, messages.length);
    const messagesToKeep = messages.slice(-keepCount);
    const messagesToRemove = messages.slice(0, messages.length - keepCount);

    // Calculate tokens saved from removed messages
    for (const msg of messagesToRemove) {
      savedTokens += this.estimateMessageTokens(msg);
    }

    // If still need more space, trim old tool outputs
    if (savedTokens < excessTokens && this.config.preserveRecentToolOutputs) {
      for (let i = 0; i < compacted.length; i++) {
        const msg = compacted[i];
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

    // Add a compaction marker
    const marker: MessageV2 = {
      id: `compact-${Date.now()}`,
      role: "user",
      parts: [{
        type: "text",
        content: `[Context compacted: ${messagesToRemove.length} messages removed, ~${savedTokens} tokens saved]`,
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

  /** Estimate tokens for text (rough: 1 token ≈ 4 chars) */
  estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
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

  /** Update config */
  updateConfig(config: Partial<CompactionConfig>) {
    this.config = { ...this.config, ...config };
  }
}

// ========== Singleton ==========
let instance: ContextManager | null = null;

export function getContextManager(): ContextManager {
  if (!instance) {
    instance = new ContextManager();
  }
  return instance;
}
