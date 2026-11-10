/**
 * LLM usage 归一化（缓存字段精确口径）
 *
 * 缓存计费口径对标 dsh TokenUsage：inputTokens = uncached 输入；
 * cacheRead / cacheWrite 单独计。命中率分母 = uncached + cacheRead + cacheWrite。
 *
 * 缺报即缺报：provider 一个缓存字段都没报时，`cacheHitTokens` /
 * `cacheReadTokens` / `cacheWriteTokens` / `uncachedInputTokens` **都不产出**
 * （undefined ≠ 0），见下方注释。
 *
 * Provider 差异（三家字段名不同，但语义可以对齐）：
 * - Anthropic：`cache_read_input_tokens`（读缓存）+ `cache_creation_input_tokens`
 *   （写缓存）；`input_tokens` 是**未命中**输入，缓存桶单独给；
 * - OpenAI：`prompt_tokens_details.cached_tokens`（部分网关只给扁平
 *   `cached_tokens`）；`prompt_tokens` **含**缓存命中部分，没有写缓存桶；
 * - DeepSeek：`prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`，
 *   `prompt_tokens = hit + miss` —— uncached 直接用 miss 最准。
 */

import type { TokenUsage } from "./types";

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
  /** 读缓存 token（与 `cacheHitTokens` 同源；新消费方用这个） */
  cacheReadTokens?: number
  /** 写缓存 token（Anthropic `cache_creation_input_tokens`；只在真的上报时存在） */
  cacheWriteTokens?: number
  /** provider 是否上报过任何缓存字段（缺失时整个属性不出现，等价于 false） */
  cacheReported?: boolean
  /** 未命中缓存的输入 token（命中率分母的 uncached 部分）；同样仅在上报时存在 */
  uncachedInputTokens?: number
}

/**
 * 只接受「有限且非负的数字」。
 *
 * 负数 / 字符串 / NaN 一律当作**没报**（返回 undefined）：
 * 这类值是坏数据，把它当 0 会伪造出「确定全未命中」的读数（本仓库最忌讳的假读数）。
 * 聚合层会把它累计成 0 并保持 `cacheReported: false`，界面据此显示「未上报」。
 */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 按优先级取第一个合法值；前面的坏值（负数/字符串）不会挡住后面的合法值 */
function firstValid(values: unknown[]): number | undefined {
  for (const value of values) {
    const n = finiteNonNegative(value)
    if (n !== undefined) return n
  }
  return undefined
}

export function parseProviderUsage(raw: Record<string, any>): NormalizedUsage {
  const promptTotal = finiteNonNegative(raw.prompt_tokens)
  /** Anthropic 的 `input_tokens` 是未命中输入（缓存桶不包含在里面） */
  const anthropicInput = finiteNonNegative(raw.input_tokens)
  // Anthropic 的完成 token 叫 `output_tokens`；OpenAI / DeepSeek 用 `completion_tokens`
  const completion = finiteNonNegative(raw.completion_tokens) ?? finiteNonNegative(raw.output_tokens) ?? 0

  const details = raw.prompt_tokens_details
  const cacheRead = firstValid([
    raw.prompt_cache_hit_tokens,
    raw.cache_read_input_tokens,
    details && typeof details === "object" ? details.cached_tokens : undefined,
    raw.cached_tokens,
  ])
  const cacheWrite = firstValid([raw.cache_creation_input_tokens])
  // DeepSeek 显式上报 miss → 直接作为 uncached（最准）
  const explicitMiss = finiteNonNegative(raw.prompt_cache_miss_tokens)

  /**
   * 两种口径的差别就在这里：
   * - 有 `prompt_tokens`（OpenAI / DeepSeek）：它是**总量**，含缓存命中；
   * - 只有 `input_tokens`（Anthropic）：它是**未命中**，总输入 = input + 读缓存
   *   （写缓存单独一桶，不计入 promptTokens —— 与 OpenAI 的「prompt 含读缓存、
   *   不含写缓存」保持同一条消费方口径：uncached + read + write 才是账单输入）。
   */
  const promptIncludesCache = promptTotal !== undefined
  const baseInput = promptTotal ?? anthropicInput ?? 0
  const promptTokens = promptIncludesCache ? baseInput : baseInput + (cacheRead ?? 0)

  const out: NormalizedUsage = {
    promptTokens,
    completionTokens: completion,
    totalTokens: promptTokens + completion,
  }

  const readKnown = cacheRead !== undefined || explicitMiss !== undefined
  if (readKnown) {
    out.cacheReported = true
    // 旧字段保持原有语义：只要上报了读缓存（或显式 miss），就给出 cacheHitTokens
    out.cacheHitTokens = cacheRead ?? 0
    if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
    out.uncachedInputTokens = explicitMiss !== undefined
      ? explicitMiss
      : promptIncludesCache
        ? Math.max(0, baseInput - (cacheRead ?? 0))
        : baseInput
  }
  if (cacheWrite !== undefined) {
    out.cacheReported = true
    out.cacheWriteTokens = cacheWrite
  }
  return out
}

/**
 * 归一化结果 → `TokenUsage`（缓存键只在真的上报时出现，另带显式 `cacheReported`）。
 *
 * 单独抽出来是因为流式（`provider.ts`）、非流式 `complete()`、以及 Anthropic
 * Messages 适配器（`aicodewith-protocols.ts`）三条 wire 路径必须给出**同一种形状** ——
 * 否则同一轮里「流式那次报了缓存、非流式这次没报」的旧缺陷会以另一种形式回来。
 */
export function toTokenUsage(nu: NormalizedUsage): TokenUsage {
  return {
    promptTokens: nu.promptTokens,
    completionTokens: nu.completionTokens,
    totalTokens: nu.totalTokens,
    cacheReported: nu.cacheReported === true,
    ...(nu.cacheHitTokens !== undefined ? { cacheHitTokens: nu.cacheHitTokens } : {}),
    ...(nu.cacheReadTokens !== undefined ? { cacheReadTokens: nu.cacheReadTokens } : {}),
    ...(nu.cacheWriteTokens !== undefined ? { cacheWriteTokens: nu.cacheWriteTokens } : {}),
    ...(nu.uncachedInputTokens !== undefined ? { uncachedInputTokens: nu.uncachedInputTokens } : {}),
  }
}
