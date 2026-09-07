/**
 * LLM usage 归一化（缓存字段精确口径）
 *
 * 缓存计费口径对标 dsh TokenUsage：inputTokens = uncached 输入；
 * cacheRead 单独计。命中率分母 = uncached + cacheRead + cacheWrite。
 *
 * Provider 差异：
 * - DeepSeek：usage.prompt_cache_hit_tokens + prompt_cache_miss_tokens，
 *   prompt_tokens = hit + miss —— uncached 直接用 miss 最准；
 * - OpenAI 兼容（cache_read_input_tokens）：prompt_tokens 是否含 cache 因
 *   实现而异 —— 无显式 miss 时取 max(0, prompt - cacheRead)（含 cache 口径）
 *   与 prompt（不含口径）的折中：对 DeepSeek 主路径恒正确。
 */

export interface NormalizedUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  /** 未命中缓存的输入 token（命中率分母的 uncached 部分） */
  uncachedInputTokens: number
}

export function parseProviderUsage(raw: Record<string, any>): NormalizedUsage {
  const promptTotal = raw.prompt_tokens || 0
  const completion = raw.completion_tokens || 0
  const cacheHit = raw.prompt_cache_hit_tokens
    ?? raw.cache_read_input_tokens
    ?? 0
  // DeepSeek 显式上报 miss → 直接作为 uncached（最准）
  const explicitMiss = raw.prompt_cache_miss_tokens
  const uncached = explicitMiss !== undefined
    ? Math.max(0, explicitMiss)
    : Math.max(0, promptTotal - cacheHit)
  return {
    promptTokens: promptTotal,
    completionTokens: completion,
    totalTokens: promptTotal + completion,
    cacheHitTokens: Math.max(0, cacheHit),
    uncachedInputTokens: uncached,
  }
}
