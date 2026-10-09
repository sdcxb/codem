/**
 * 缓存命中率显示格式（对标 dsh token-meter/turn-usage token-format）。
 *
 * dsh 客户端显示精确缓存命中百分比（如 99.9% / 99.97%），且**不把
 * 非全命中四舍五入成 100%**——当普通精度会把部分命中圆成 100 时，自动
 * 增加小数位保持诚实（99.97% 而非 100%）。
 *
 * 算法移植自 dsh token-format.ts（roundedPercentUnits 用整数算术避免浮点
 * 误差；正舍入绑定 0.5 进位规则保持一致）。
 */

/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

/**
 * Display-ready cache-hit share without rounding a partial hit to 100%.
 * @param cacheReadTokens - exact prompt tokens served from cache.
 * @param promptTokens - exact aggregate prompt tokens（billed 输入总数）。
 * @param decimalPlaces - ordinary-ratio precision; partial hits that would
 * round to 100 automatically use enough additional precision to stay honest.
 * @returns percentage text, or null when there was no prompt input.
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)

  // 部分命中却会圆成 100 —— 增加小数位保持诚实（99.97% 而非 100%）
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
}

/** 一次请求的缓存读数（只取 provider 真的报了的字段） */
export interface PromptCacheReading {
  promptTokens: number;
  /** provider 上报的命中 token；**缺报时必须是 `undefined`**（不许拿 0 顶上） */
  cacheHitTokens?: number;
  /** 未命中输入 token（DeepSeek 显式 miss 最准；缺报时用 prompt − hit 推） */
  uncachedInputTokens?: number;
}

/**
 * 一行**服务端前缀缓存**读数（第 191 波 O-48 的证据来源）。
 *
 * ## 为什么需要它（它是一条判据工具，不是装饰性日志）
 *
 * O-48 的问题是「要不要为提示装配引入跨轮状态（delta 通道）」，而答案取决于一个
 * **今天没人量过的数**：服务端 KV 缓存到底命中到哪一段。O-54 因此把「三家服务端 KV 命中率」
 * 归为**不可观测** —— 但那是**对标取证**里的口径；**我们自己的链路是可观测的**：
 * `usage-normalize.ts` 已经把 DeepSeek 的 `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens`（以及 OpenAI 形状的 `cache_read_input_tokens`）归一化进
 * `TokenUsage.cacheHitTokens`，只是**从来没有按请求打到日志里**（只有界面上的一个百分比）。
 *
 * 所以这里把它变成一行可复核日志：任何一次真机回合都能看到
 * 「这一请求命中多少 / 未命中多少 / 总 prompt 多少 / 命中率」，
 * 从而**直接判定**下面两种缓存语义哪一种成立（这正是 delta 通道值不值得做的分水岭）：
 *
 * - 语义 A（整请求前缀匹配，命中范围 = 到首个差异点）：同一轮里第 N+1 次迭代的 `hit` 会
 *   覆盖「稳定前缀 + 上一次迭代的全部历史」⇒ delta 通道省下的是**历史的重算**（大）；
 * - 语义 B（只有稳定前缀进入缓存）：第 N+1 次的 `hit` 只覆盖稳定前缀那一段
 *   ⇒ delta 通道几乎不额外省什么（小），189 波那套「位置固定在尾部」已经把可控的部分吃满。
 *
 * 诚实纪律（与 `usage-normalize.ts` 同一条）：**provider 没报就不许编**。
 * 缺报时输出 `hit=? miss=? ratio=?` 并写明原因，绝不写 `hit=0`（那是编造一个"全未命中"的读数）。
 */
export function formatPromptCacheLog(usage: PromptCacheReading): string {
  const prompt = Number(usage?.promptTokens ?? 0);
  const hit = usage?.cacheHitTokens;
  if (hit === undefined) {
    return `[prompt-cache] hit=? miss=? prompt=${prompt} ratio=?（provider 本次未上报缓存字段）`;
  }
  const miss = usage.uncachedInputTokens !== undefined ? usage.uncachedInputTokens : Math.max(0, prompt - hit);
  const ratio = formatCacheHitPercent(hit, prompt, 1);
  return `[prompt-cache] hit=${hit} miss=${miss} prompt=${prompt} ratio=${ratio === null ? "?" : `${ratio}%`}`;
}
