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

  // token 统计
  if (meta.usage) {
    const u = meta.usage
    stats.inputTokens = u.promptTokens || u.inputTokens || 0
    stats.outputTokens = u.completionTokens || u.outputTokens || 0
    stats.cacheReadTokens = u.cacheReadTokens || 0
    stats.cacheWriteTokens = u.cacheWriteTokens || 0
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

/** cache hit 率 */
function cacheHitPercent(stats: WindowStats): number | null {
  const denom = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  return denom === 0 ? null : Math.round(stats.cacheReadTokens / denom * 100)
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

  // 第 3 组：token 计数 + cache hit
  const billed = billedInputTokens(stats)
  if (billed > 0 || stats.outputTokens > 0) {
    const hit = cacheHitPercent(stats)
    if (hit !== null) {
      groups.push(zh ? `缓存命中 ${hit}%` : `Cache ${hit}%`)
    }
    groups.push(
      zh
        ? `${formatTokens(billed)} 入 / ${formatTokens(stats.outputTokens)} 出`
        : `${formatTokens(billed)} in / ${formatTokens(stats.outputTokens)} out`
    )
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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 'var(--fs-xs)',
        color: 'var(--text-muted)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        marginTop: 4,
        opacity: 0.8,
      }}
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
