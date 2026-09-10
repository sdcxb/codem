/**
 * StatsLine — 助手消息统计行
 *
 * 对标 DSH ui-conversation/src/client/chat/StatsLine.tsx
 * 在助手消息底部展示：turns/steps 计数、LLM 耗时、tool 耗时、
 * TTFT 平均延迟、解码吞吐量（tokens/s）、token 总量、cache hit 率。
 *
 * 数据来源：从 message 的 toolCalls 和 trajectory metadata 中推导。
 * 管道分隔符分组显示，无数据的组自动省略。
 */

import { memo, useMemo, useLayoutEffect, useRef, useState, Fragment } from 'react'
import type { Message } from '../store'
import { useLang, getLang } from '../core/i18n/lang'
import { formatCacheHitPercent } from '../core/llm/cache-percent'

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

  // LLM 耗时：从 metadata.llmDuration 或 reasoning 时长推导
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

  // token 统计（cache 字段真实化：usage.cacheHitTokens = DeepSeek
  // prompt_cache_hit_tokens；inputTokens 取 uncached 口径避免与 cache 重复计）
  if (meta.usage) {
    const u = meta.usage
    const promptTotal = u.promptTokens || u.inputTokens || 0
    const cacheRead = u.cacheHitTokens ?? u.cacheReadTokens ?? 0
    stats.cacheReadTokens = cacheRead
    stats.cacheWriteTokens = u.cacheWriteTokens || 0
    stats.inputTokens = u.uncachedInputTokens ?? Math.max(0, promptTotal - cacheRead)
    stats.outputTokens = u.completionTokens || u.outputTokens || 0
    if (typeof u.cost === "number") stats.cost = u.cost
    // provider 是否明确上报缓存字段——未上报（如非 DeepSeek 系）时命中率未知，
    // 不得显示误导性的"缓存命中 0%"
    stats.cacheReported =
      u.cacheHitTokens !== undefined ||
      u.cacheReadTokens !== undefined ||
      u.uncachedInputTokens !== undefined
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

  return stats
}

/** cache hit 率（dsh 高精度格式：不把部分命中四舍五入成 100，如 99.97%） */
function cacheHitPercent(stats: WindowStats): string | null {
  const denom = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  return formatCacheHitPercent(stats.cacheReadTokens, denom, 1)
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

  // 管道分隔的分组
  const groups: string[] = []

  // 第 1 组：turns/steps + 耗时
  if (stats.steps > 0) {
    if (zh) {
      groups.push(`${stats.turns} 轮 · ${stats.steps} 步`)
    } else {
      groups.push(`${stats.turns} turn${stats.turns > 1 ? 's' : ''} · ${stats.steps} step${stats.steps > 1 ? 's' : ''}`)
    }
    const durations: string[] = []
    if (stats.llmMs > 0) {
      durations.push(zh ? `LLM ${formatDuration(stats.llmMs)}` : `LLM ${formatDuration(stats.llmMs)}`)
    }
    if (stats.toolMs > 0) {
      durations.push(zh ? `工具 ${formatDuration(stats.toolMs)}` : `Tools ${formatDuration(stats.toolMs)}`)
    }
    if (durations.length > 0) groups.push(durations.join(' · '))
  }

  // 第 2 组：速度指标
  const speeds: string[] = []
  if (stats.ttftSteps > 0 && stats.ttftMs > 0) {
    const avgTtft = stats.ttftMs / stats.ttftSteps
    speeds.push(zh ? `TTFT ${formatDuration(avgTtft)}` : `TTFT ${formatDuration(avgTtft)}`)
  }
  if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
    const tps = stats.decodeTokens / (stats.decodeMs / 1000)
    speeds.push(`${formatTokensPerSecond(tps)} tok/s`)
  }
  if (speeds.length > 0) groups.push(speeds.join(' · '))

  // 第 3 组：token 计数 + cache hit（仅当 provider 上报缓存字段时显示命中率）
  const billed = billedInputTokens(stats)
  if (billed > 0 || stats.outputTokens > 0) {
    const hit = stats.cacheReported ? cacheHitPercent(stats) : null
    if (hit !== null) {
      groups.push(zh ? `缓存命中 ${hit}%` : `Cache ${hit}%`)
    }
    groups.push(
      zh
        ? `${formatTokens(billed)} 入 / ${formatTokens(stats.outputTokens)} 出`
        : `${formatTokens(billed)} in / ${formatTokens(stats.outputTokens)} out`
    )
    if (stats.cost > 0) {
      groups.push(`≈$${formatCost(stats.cost)}`)
    }
  }

  if (groups.length === 0) return null

  const line = groups.join(' | ')

  // 截断检测 + tooltip
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return
    const measure = () => { setTruncated(el.scrollWidth > el.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [line])

  return (
    <div
      ref={rootRef}
      className="stats-line"
      title={truncated ? line : undefined}
    >
      {groups.map((group, i) => (
        <Fragment key={group}>
          {i > 0 && <span style={{ opacity: 0.4, margin: '0 2px' }}>|</span>}
          <span>{group}</span>
        </Fragment>
      ))}
    </div>
  )
})

