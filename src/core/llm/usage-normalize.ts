/**
 * LLM usage 归一化（缓存字段精确口径）
 *
 * 缓存计费口径对标 dsh TokenUsage：inputTokens = uncached 输入；
 * cacheRead 单独计。命中率分母 = uncached + cacheRead + cacheWrite。
 *
 * 缺报即缺报：provider 一个缓存字段都没报时，`cacheHitTokens` /
 * `uncachedInputTokens` **不产出**（undefined ≠ 0），见下方注释。
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
  /**
   * 命中缓存的输入 token。**仅在 provider 实际上报时存在** ——
   * 「没上报」与「上报 0」必须可区分（见 `token-tracker.ts` 里
   * 删掉 30% 猜测的说明）。
   */
  cacheHitTokens?: number
  /** 未命中缓存的输入 token（命中率分母的 uncached 部分）；同样仅在上报时存在 */
  uncachedInputTokens?: number
}

export function parseProviderUsage(raw: Record<string, any>): NormalizedUsage {
  const promptTotal = raw.prompt_tokens || 0
  const completion = raw.completion_tokens || 0
  const cacheHit = raw.prompt_cache_hit_tokens
    ?? raw.cache_read_input_tokens
  // DeepSeek 显式上报 miss → 直接作为 uncached（最准）
  const explicitMiss = raw.prompt_cache_miss_tokens
  /**
   * 缓存字段只在 provider **真的报了**其中之一时才产出：
   * 「两个字段都没有」= 这个 provider 不报缓存（例如 ollama），
   * 此时既不是命中 0、也不该显示命中率 —— 所以两个键都**不出现**，
   * 而不是被强制填成 0（旧行为把"未知"伪装成"确定命中 0"，
   * 让 `StatsLine.cacheReported` / `UsageStats` 的"未上报不显示"判据失效）。
   * `promptTokens` / `completionTokens` / `totalTokens` 不受影响。
   */
  const hasCacheReport = cacheHit !== undefined || explicitMiss !== undefined
  const out: NormalizedUsage = {
    promptTokens: promptTotal,
    completionTokens: completion,
    totalTokens: promptTotal + completion,
  }
  if (hasCacheReport) {
    out.cacheHitTokens = Math.max(0, cacheHit ?? 0)
    out.uncachedInputTokens = explicitMiss !== undefined
      ? Math.max(0, explicitMiss)
      : Math.max(0, promptTotal - (cacheHit ?? 0))
  }
  return out
}
