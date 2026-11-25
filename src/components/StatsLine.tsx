/**
 * StatsLine — 助手消息的「运行详情」入口（compact）
 *
 * 对标 DSH ui-conversation 的统计行，但默认形态不再是**一长行原始指标**：
 * - `<summary>` 只放人读摘要：轮 / 步 / 总耗时；
 * - token、cache 命中、费用、TTFT、解码吞吐全收进 `<details>`，展开后与旧版逐项一致；
 * - 没有额外指标时连 `<details>` 都不画（不给一个空折叠壳）。
 *
 * 数据来源：从 message 的 toolCalls 和 trajectory metadata 中推导。
 * 空值 / 未上报语义原样保留：provider 没报缓存字段时**不显示**命中率
 * （绝不写成「缓存命中 0%」）。
 */

import { memo, useMemo, useState } from 'react'
import type { Message } from '../store'
import { useLang } from '../core/i18n/lang'
import { summarizeCacheUsage, formatCacheUsageLabel } from '../core/llm/cache-percent'

/** 紧凑 token 计数格式：517 / 12.2K / 517K / 1.2M */
function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** 紧凑时长格式：45.2s 以下用秒，以上用 2m42s */
function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** 解码吞吐率格式：10+ 整数，以下一位小数 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 成本格式：小额用足够小数位（≈$0.0003），大额两位 */
function formatCost(cost: number): string {
  if (cost >= 0.01) return cost.toFixed(2)
  if (cost >= 0.001) return cost.toFixed(3)
  if (cost >= 0.0001) return cost.toFixed(4)
  return cost.toFixed(5)
}

interface WindowStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  /**
   * 摘要用的"总耗时"（人读）。
   *
   * 有 `turnStartTime/turnEndTime`（真正的回合墙钟）时用它 —— 这个区间**已经包含**
   * 工具执行时间，再和 `toolMs` 相加就会重复计时；没有墙钟时才退化为
   * `llmMs + toolMs`（两者的顺序阶段相加）。
   */
  turnMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /** provider 是否明确上报缓存字段（未上报不显示命中率，防误导 0%） */
  cacheReported: boolean
}

/** 从消息的 toolCalls 和 metadata 中推导统计指标 */
function deriveStats(message: Message): WindowStats {
  const stats: WindowStats = {
    turns: 1,
    steps: 1,
    llmMs: 0,
    toolMs: 0,
    turnMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    cacheReported: false,
  }

  // LLM 耗时：从 metadata.llmDuration 或回合墙钟推导
  const meta = message.metadata || {}
  if (meta.llmDuration) {
    stats.llmMs = meta.llmDuration as number
  } else if (meta.turnStartTime && meta.turnEndTime) {
    stats.llmMs = Math.max(0, meta.turnEndTime - meta.turnStartTime)
  }

  // TTFT 和解码吞吐
  if (meta.ttftMs) {
    stats.ttftMs = meta.ttftMs as number
    stats.ttftSteps = 1
  }
  if (meta.decodeMs && meta.outputTokens) {
    stats.decodeMs = meta.decodeMs as number
    stats.decodeTokens = meta.outputTokens as number
  }

  // token 统计（cache 字段真实化：读缓存优先新字段 `cacheReadTokens`，
  // 旧字段 `cacheHitTokens` 兜底；inputTokens 取 uncached 口径避免与 cache 重复计）
  if (meta.usage) {
    const u = meta.usage
    const promptTotal = u.promptTokens || u.inputTokens || 0
    const cacheRead = u.cacheReadTokens ?? u.cacheHitTokens ?? 0
    stats.cacheReadTokens = cacheRead
    stats.cacheWriteTokens = u.cacheWriteTokens || 0
    stats.inputTokens = u.uncachedInputTokens ?? Math.max(0, promptTotal - cacheRead)
    stats.outputTokens = u.completionTokens || u.outputTokens || 0
    if (typeof u.cost === "number") stats.cost = u.cost
    /**
     * 是否上报只认**显式的 `cacheReported`**（新消息由聚合层写入）：
     * 老消息的 metadata.usage 里 `cacheHitTokens` 恒为 0（旧聚合初始化），
     * 按键存在性判断会把「未上报」显示成「缓存命中 0%」——本波修的就是它。
     */
    stats.cacheReported = u.cacheReported === true
  }

  // tool 耗时
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      const tcMeta = tc.metadata || {}
      if (tcMeta.duration) {
        stats.toolMs += tcMeta.duration as number
      }
    }
  }

  const turnWindowMs =
    meta.turnStartTime && meta.turnEndTime
      ? Math.max(0, (meta.turnEndTime as number) - (meta.turnStartTime as number))
      : 0
  stats.turnMs = turnWindowMs > 0 ? turnWindowMs : stats.llmMs + stats.toolMs

  return stats
}

/** billed input tokens */
function billedInputTokens(stats: WindowStats): number {
  return stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
}

export interface StatsLineProps {
  message: Message
}

export const StatsLine = memo(function StatsLine({ message }: StatsLineProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const stats = useMemo(() => deriveStats(message), [message])
  const [expanded, setExpanded] = useState(false)

  // ===== summary：只放人读信息（轮 / 步 / 总耗时） =====
  const summaryParts: string[] = [
    zh
      ? `${stats.turns} 轮`
      : `${stats.turns} turn${stats.turns > 1 ? 's' : ''}`,
    zh
      ? `${stats.steps} 步`
      : `${stats.steps} step${stats.steps > 1 ? 's' : ''}`,
  ]
  if (stats.turnMs > 0) {
    summaryParts.push(
      zh
        ? `总耗时 ${formatDuration(stats.turnMs)}`
        : `total ${formatDuration(stats.turnMs)}`,
    )
  }
  const summaryText = summaryParts.join(' · ')

  // ===== details：原有全部原始指标，一项不少 =====
  const detailGroups: string[] = []

  // 第 1 组：LLM / 工具耗时拆分
  const durations: string[] = []
  if (stats.llmMs > 0) {
    durations.push(`LLM ${formatDuration(stats.llmMs)}`)
  }
  if (stats.toolMs > 0) {
    durations.push(zh ? `工具 ${formatDuration(stats.toolMs)}` : `Tools ${formatDuration(stats.toolMs)}`)
  }
  if (durations.length > 0) detailGroups.push(durations.join(' · '))

  // 第 2 组：速度指标
  const speeds: string[] = []
  if (stats.ttftSteps > 0 && stats.ttftMs > 0) {
    const avgTtft = stats.ttftMs / stats.ttftSteps
    speeds.push(`TTFT ${formatDuration(avgTtft)}`)
  }
  if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
    const tps = stats.decodeTokens / (stats.decodeMs / 1000)
    speeds.push(`${formatTokensPerSecond(tps)} tok/s`)
  }
  if (speeds.length > 0) detailGroups.push(speeds.join(' · '))

  // 第 3 组：token 计数 + cache 读数（仅当 provider 上报缓存字段时显示；
  // 未上报时整组不出现，绝不显示误导性的「缓存命中 0%」）
  const billed = billedInputTokens(stats)
  if (billed > 0 || stats.outputTokens > 0) {
    if (stats.cacheReported) {
      const summary = summarizeCacheUsage({
        /* prompt 口径 = uncached + 读缓存（写缓存是独立桶，由 summary 自己加进分母） */
        promptTokens: stats.inputTokens + stats.cacheReadTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        cacheReported: true,
      })
      detailGroups.push(formatCacheUsageLabel(summary))
    }
    detailGroups.push(
      zh
        ? `${formatTokens(billed)} 入 / ${formatTokens(stats.outputTokens)} 出`
        : `${formatTokens(billed)} in / ${formatTokens(stats.outputTokens)} out`
    )
    if (stats.cost > 0) {
      detailGroups.push(`≈$${formatCost(stats.cost)}`)
    }
  }

  // 没有可折叠的原始指标 ⇒ 只画一行摘要，不给空折叠壳
  // （不套 `.stats-line-summary`：集成方那份 CSS 给它加了展开箭头，静态行会假装可点）
  if (detailGroups.length === 0) {
    return <div className="stats-line--compact">{summaryText}</div>
  }

  return (
    <details
      className="stats-line--compact"
      open={expanded}
      onToggle={(event) => {
        /**
         * `<summary>` 的原生 toggle 已经改过 DOM；这里只把 state 对齐它。
         * 不要在 `onClick` 里再手翻一次 —— 原生 toggle 与手动翻转会互相抵消
         * （实测：state 先 true 再被 click 的 updater 翻回 false）。
         */
        const next = event.currentTarget.open
        setExpanded((prev) => (prev === next ? prev : next))
      }}
    >
      <summary className="stats-line-summary" title={zh ? '运行详情' : 'Run details'}>
        {summaryText}
      </summary>
      <div className="stats-line-body">
        {detailGroups.map((group, index) => (
          <div className="stats-line-metric" key={`${index}-${group}`}>
            {group}
          </div>
        ))}
      </div>
    </details>
  )
})
