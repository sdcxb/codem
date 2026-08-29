/**
 * TrajectoryPanel — 执行轨迹详情面板
 *
 * 对标 DSH ui-trajectory/src/client/TrajectoryView.tsx。
 * 展示 Agent 每步执行的完整轨迹：LLM 调用、工具调用、工具结果、错误等。
 * 以时间线形式呈现，支持折叠/展开、按类型过滤。
 *
 * 与 ActivityTimeline 的分工：
 * - TrajectoryPanel: 完整执行轨迹面板（对标 DSH TrajectoryView），包含 LLM 调用细节
 * - ActivityTimeline: 轻量级活动时间线（已有的工具调用时间线）
 *
 * 数据来源（双通道）：
 * 1. 优先从 TrajectoryService（ctx.get('uiTrajectory')）获取实时轨迹记录
 * 2. 回退到从 conversation messages 中提取工具调用和 LLM 交互记录
 */

import { memo, useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  ChevronDown, ChevronRight, Wrench, Brain, MessageSquare,
  CheckCircle2, XCircle, LoaderCircle, AlertCircle, Clock, Filter,
  Cpu, Zap, Activity, Timer, Gauge, TrendingUp,
} from 'lucide-react'
import { useLang } from '../core/i18n/lang'
import { tryGetCtx } from '../core/consumer/index'

/** 轨迹步骤类型 */
export type TrajectoryStepType =
  | 'llm_call'
  | 'tool_call'
  | 'tool_result'
  | 'user_input'
  | 'assistant_output'
  | 'error'
  | 'turn_end'

/** 轨迹步骤 */
export interface TrajectoryStep {
  id: string
  type: TrajectoryStepType
  data: any
  timestamp: number
  duration?: number
}

export interface TrajectoryPanelProps {
  /** 轨迹步骤列表（外部提供，优先级最高） */
  steps?: TrajectoryStep[]
  /** 从消息列表加载轨迹（回退数据源） */
  messages?: any[]
  /** 默认展开 */
  defaultExpanded?: boolean
}

/** 类型图标 */
function TypeIcon({ type }: { type: TrajectoryStepType }) {
  switch (type) {
    case 'llm_call': return <Brain size={13} style={{ color: 'var(--accent)' }} />
    case 'tool_call': return <Wrench size={13} style={{ color: 'var(--info)' }} />
    case 'tool_result': return <CheckCircle2 size={13} style={{ color: 'var(--success)' }} />
    case 'user_input': return <MessageSquare size={13} style={{ color: 'var(--text-secondary)' }} />
    case 'assistant_output': return <MessageSquare size={13} style={{ color: 'var(--text-primary)' }} />
    case 'error': return <AlertCircle size={13} style={{ color: 'var(--error)' }} />
    case 'turn_end': return <Activity size={13} style={{ color: 'var(--text-muted)' }} />
    default: return <Clock size={13} />
  }
}

/** 类型标签 */
function typeLabel(type: TrajectoryStepType, zh: boolean): string {
  const labels: Record<TrajectoryStepType, { zh: string; en: string }> = {
    llm_call: { zh: 'LLM 调用', en: 'LLM Call' },
    tool_call: { zh: '工具调用', en: 'Tool Call' },
    tool_result: { zh: '工具结果', en: 'Tool Result' },
    user_input: { zh: '用户输入', en: 'User Input' },
    assistant_output: { zh: '助手输出', en: 'Assistant Output' },
    error: { zh: '错误', en: 'Error' },
    turn_end: { zh: '轮次结束', en: 'Turn End' },
  }
  return labels[type]?.[zh ? 'zh' : 'en'] || type
}

/** 格式化时间 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const s = d.getSeconds().toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

/** 格式化持续时长 */
function formatDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 紧凑 token 计数格式 */
function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** 格式化吞吐率 */
function formatTps(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 从轨迹步骤推导 turn 级聚合指标 — 对标 DSH deriveTurnMetrics */
interface TurnMetrics {
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
}

function deriveTurnMetrics(steps: TrajectoryStep[]): TurnMetrics {
  const metrics: TurnMetrics = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0,
    ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    inputTokens: 0, outputTokens: 0,
  }
  const turnIds = new Set<number>()
  for (const step of steps) {
    if (step.type === 'turn_end') {
      metrics.turns++
      if (step.data?.duration_ms) metrics.llmMs += step.data.duration_ms
      if (step.data?.iterations) metrics.steps += step.data.iterations
    }
    if (step.type === 'llm_call') {
      if (step.data?.usage) {
        metrics.inputTokens += step.data.usage.promptTokens || step.data.usage.inputTokens || 0
        metrics.outputTokens += step.data.usage.completionTokens || step.data.usage.outputTokens || 0
      }
      if (step.data?.ttftMs) {
        metrics.ttftMs += step.data.ttftMs
        metrics.ttftSteps++
      }
      if (step.data?.decodeMs && step.data?.outputTokens) {
        metrics.decodeMs += step.data.decodeMs
        metrics.decodeTokens += step.data.outputTokens
      }
    }
    if (step.type === 'tool_call' || step.type === 'tool_result') {
      if (step.duration) metrics.toolMs += step.duration
    }
  }
  return metrics
}

/** 从消息列表提取轨迹步骤（回退数据源） */
function extractStepsFromMessages(messages: any[]): TrajectoryStep[] {
  const steps: TrajectoryStep[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      steps.push({
        id: `step-${steps.length}`,
        type: 'user_input',
        data: { content: msg.content },
        timestamp: msg.timestamp || Date.now(),
      })
    } else if (msg.role === 'assistant') {
      steps.push({
        id: `step-${steps.length}`,
        type: 'assistant_output',
        data: { content: msg.content },
        timestamp: msg.timestamp || Date.now(),
      })
      // 提取工具调用
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          steps.push({
            id: `step-${steps.length}`,
            type: 'tool_call',
            data: { name: tc.function?.name, args: tc.function?.arguments },
            timestamp: msg.timestamp || Date.now(),
          })
        }
      }
    } else if (msg.role === 'tool') {
      steps.push({
        id: `step-${steps.length}`,
        type: 'tool_result',
        data: { content: msg.content },
        timestamp: msg.timestamp || Date.now(),
      })
    }
  }
  return steps
}

/** 从 TrajectoryService 获取实时轨迹步骤 */
function useTrajectorySteps(sessionId: string | null): TrajectoryStep[] {
  const [steps, setSteps] = useState<TrajectoryStep[]>([])
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // 清理上一次订阅
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
      unsubscribeRef.current = null
    }

    try {
      const ctx = tryGetCtx()
      if (!ctx) return
      const svc = (ctx as any).get('uiTrajectory')
      if (!svc) return

      // 获取已有轨迹
      if (sessionId) {
        const existing = svc.getSessionTrajectory?.(sessionId) || []
        if (existing.length > 0) setSteps(existing)
      }

      // 订阅新轨迹步骤
      const unsubscribe = svc.subscribe?.((sid: string, step: TrajectoryStep) => {
        if (sid === sessionId) {
          setSteps(prev => [...prev, step])
        }
      })
      if (unsubscribe) unsubscribeRef.current = unsubscribe
    } catch {
      // Context 未初始化 — 静默降级
    }

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [sessionId])

  return steps
}

/**
 * 执行轨迹详情面板。
 * 以时间线形式展示 Agent 每步执行轨迹。
 * 数据源：优先从 TrajectoryService 获取，回退到 messages 推断。
 */
export const TrajectoryPanel = memo(function TrajectoryPanel({
  steps: providedSteps,
  messages,
  defaultExpanded = true,
}: TrajectoryPanelProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<TrajectoryStepType | 'all'>('all')

  // 从 TrajectoryService 获取实时轨迹（使用当前 session ID）
  const sessionId = useMemo(() => {
    // 尝试从消息中获取 session ID
    if (messages && messages.length > 0) {
      const first = messages[0]
      return first?.sessionId || first?.session_id || null
    }
    return null
  }, [messages])

  const serviceSteps = useTrajectorySteps(sessionId)

  // 数据源优先级：providedSteps > serviceSteps > messages 推断
  const steps = useMemo(() => {
    if (providedSteps && providedSteps.length > 0) return providedSteps
    if (serviceSteps.length > 0) return serviceSteps
    if (messages && messages.length > 0) return extractStepsFromMessages(messages)
    return []
  }, [providedSteps, serviceSteps, messages])

  const filteredSteps = useMemo(() => {
    if (filter === 'all') return steps
    return steps.filter(s => s.type === filter)
  }, [steps, filter])

  const toggleStep = useCallback((id: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (steps.length === 0) return null

  // 推导 turn 级聚合指标
  const turnMetrics = useMemo(() => deriveTurnMetrics(steps), [steps])

  const filterTypes: (TrajectoryStepType | 'all')[] = ['all', 'llm_call', 'tool_call', 'tool_result', 'assistant_output', 'error', 'turn_end']

  return (
    <div className="trajectory-panel" style={{ borderTop: '1px solid var(--border-primary)' }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          cursor: 'pointer',
          fontSize: 12,
          color: 'var(--text-secondary)',
          userSelect: 'none',
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Activity size={13} />
        <span style={{ fontWeight: 600 }}>
          {zh ? '执行轨迹' : 'Trajectory'}
        </span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>
          ({filteredSteps.length})
        </span>

        {/* 过滤器 */}
        {expanded && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Filter size={11} style={{ opacity: 0.5 }} />
            {filterTypes.map(t => (
              <button
                key={t}
                onClick={e => { e.stopPropagation(); setFilter(t) }}
                style={{
                  padding: '1px 6px',
                  borderRadius: 8,
                  border: 'none',
                  background: filter === t ? 'var(--accent-alpha)' : 'transparent',
                  color: filter === t ? 'var(--accent)' : 'var(--text-muted)',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                {t === 'all' ? (zh ? '全部' : 'All') : typeLabel(t as TrajectoryStepType, zh)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Turn 级聚合指标行 — 对标 DSH StatsLine */}
      {expanded && turnMetrics.turns > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 12px',
          fontSize: 10,
          color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border-primary)',
          flexWrap: 'wrap',
        }}>
          <Timer size={10} />
          <span>{turnMetrics.turns} turn{turnMetrics.turns > 1 ? 's' : ''} · {turnMetrics.steps} step{turnMetrics.steps > 1 ? 's' : ''}</span>
          {turnMetrics.llmMs > 0 && <><span style={{ opacity: 0.3 }}>|</span><span>LLM {formatDuration(turnMetrics.llmMs)}</span></>}
          {turnMetrics.toolMs > 0 && <><span style={{ opacity: 0.3 }}>|</span><span>Tools {formatDuration(turnMetrics.toolMs)}</span></>}
          {turnMetrics.ttftSteps > 0 && turnMetrics.ttftMs > 0 && (
            <><span style={{ opacity: 0.3 }}>|</span><Gauge size={10} /><span>TTFT {formatDuration(turnMetrics.ttftMs / turnMetrics.ttftSteps)}</span></>
          )}
          {turnMetrics.decodeMs > 0 && turnMetrics.decodeTokens > 0 && (
            <><span style={{ opacity: 0.3 }}>|</span><TrendingUp size={10} /><span>{formatTps(turnMetrics.decodeTokens / (turnMetrics.decodeMs / 1000))} tok/s</span></>
          )}
          {(turnMetrics.inputTokens > 0 || turnMetrics.outputTokens > 0) && (
            <><span style={{ opacity: 0.3 }}>|</span><Zap size={10} /><span>{formatTokens(turnMetrics.inputTokens)} in / {formatTokens(turnMetrics.outputTokens)} out</span></>
          )}
        </div>
      )}

      {/* Steps timeline */}
      {expanded && (
        <div style={{ maxHeight: 400, overflowY: 'auto', padding: '0 12px 8px' }}>
          {filteredSteps.map((step, idx) => {
            const isExpanded = expandedSteps.has(step.id)
            const hasDetail = step.data && (
              (typeof step.data.content === 'string' && step.data.content.length > 100) ||
              step.data.args ||
              step.data.result ||
              step.data.error ||
              step.data.usage ||
              step.data.provider
            )
            return (
              <div
                key={step.id || idx}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '4px 0',
                  borderBottom: idx < filteredSteps.length - 1 ? '1px solid var(--border-primary)' : 'none',
                }}
              >
                {/* 时间线节点 */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <TypeIcon type={step.type} />
                  {idx < filteredSteps.length - 1 && (
                    <div style={{ width: 1, flex: 1, background: 'var(--border-primary)', marginTop: 2 }} />
                  )}
                </div>

                {/* 内容 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{typeLabel(step.type, zh)}</span>
                    {step.data?.name && (
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--accent)' }}>
                        {step.data.name}
                      </span>
                    )}
                    {/* LLM 调用细节：provider + model */}
                    {step.data?.provider && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, color: 'var(--text-muted)' }}>
                        <Cpu size={9} />
                        {step.data.provider}
                      </span>
                    )}
                    {step.data?.model && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        · {step.data.model}
                      </span>
                    )}
                    {/* token usage 展示 */}
                    {step.data?.usage && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, color: 'var(--text-muted)' }}>
                        <Zap size={9} />
                        {step.data.usage.totalTokens || 0} tokens
                      </span>
                    )}
                    {/* iteration 标记 */}
                    {step.data?.iteration != null && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        · #{step.data.iteration}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Clock size={9} />
                      {formatTime(step.timestamp)}
                      {step.duration && <span>· {formatDuration(step.duration)}</span>}
                    </span>
                  </div>

                  {/* 摘要行 */}
                  {step.data?.content && typeof step.data.content === 'string' && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        cursor: hasDetail ? 'pointer' : 'default',
                      }}
                      onClick={() => hasDetail && toggleStep(step.id)}
                    >
                      {step.data.content.slice(0, 120)}
                      {step.data.content.length > 120 && '...'}
                      {hasDetail && (isExpanded ? <ChevronDown size={10} style={{ display: 'inline', marginLeft: 4 }} /> : <ChevronRight size={10} style={{ display: 'inline', marginLeft: 4 }} />)}
                    </div>
                  )}

                  {/* error 摘要 */}
                  {step.data?.error && !step.data?.content && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--error)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        cursor: hasDetail ? 'pointer' : 'default',
                      }}
                      onClick={() => hasDetail && toggleStep(step.id)}
                    >
                      {step.data.error.slice(0, 120)}
                      {step.data.error.length > 120 && '...'}
                      {hasDetail && (isExpanded ? <ChevronDown size={10} style={{ display: 'inline', marginLeft: 4 }} /> : <ChevronRight size={10} style={{ display: 'inline', marginLeft: 4 }} />)}
                    </div>
                  )}

                  {/* result 摘要 */}
                  {step.data?.result && !step.data?.content && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        cursor: hasDetail ? 'pointer' : 'default',
                      }}
                      onClick={() => hasDetail && toggleStep(step.id)}
                    >
                      {typeof step.data.result === 'string' ? step.data.result.slice(0, 120) : JSON.stringify(step.data.result).slice(0, 120)}
                      {'...'}
                      {hasDetail && (isExpanded ? <ChevronDown size={10} style={{ display: 'inline', marginLeft: 4 }} /> : <ChevronRight size={10} style={{ display: 'inline', marginLeft: 4 }} />)}
                    </div>
                  )}

                  {/* 展开详情 */}
                  {isExpanded && step.data && (
                    <div
                      style={{
                        marginTop: 4,
                        padding: 8,
                        background: 'var(--bg-tertiary)',
                        borderRadius: 4,
                        fontSize: 11,
                        fontFamily: step.data.args || step.data.result ? 'monospace' : 'inherit',
                        whiteSpace: 'pre-wrap',
                        maxHeight: 200,
                        overflowY: 'auto',
                      }}
                    >
                      {/* LLM usage 详情 */}
                      {step.data.usage && (
                        <div style={{ marginBottom: 4 }}>
                          <strong>Token Usage:</strong> prompt={step.data.usage.promptTokens || 0}, completion={step.data.usage.completionTokens || 0}, total={step.data.usage.totalTokens || 0}
                        </div>
                      )}
                      {/* provider/model 详情 */}
                      {step.data.provider && (
                        <div style={{ marginBottom: 4 }}>
                          <strong>Provider:</strong> {step.data.provider} | <strong>Model:</strong> {step.data.model || 'N/A'}
                        </div>
                      )}
                      {step.data.args && (
                        <div>
                          <strong>Args:</strong> {typeof step.data.args === 'string' ? step.data.args : JSON.stringify(step.data.args, null, 2)}
                        </div>
                      )}
                      {step.data.content && (
                        <div>
                          <strong>Content:</strong> {step.data.content}
                        </div>
                      )}
                      {step.data.result && (
                        <div>
                          <strong>Result:</strong> {typeof step.data.result === 'string' ? step.data.result : JSON.stringify(step.data.result, null, 2)}
                        </div>
                      )}
                      {step.data.error && (
                        <div style={{ color: 'var(--error)' }}>
                          <strong>Error:</strong> {step.data.error}
                        </div>
                      )}
                      {/* turn_end 详情 */}
                      {step.data.reason && (
                        <div>
                          <strong>Stop Reason:</strong> {step.data.reason} | <strong>Duration:</strong> {formatDuration(step.data.duration_ms)} | <strong>Iterations:</strong> {step.data.iterations || 0}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})
