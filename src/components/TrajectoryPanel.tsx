/**
 * TrajectoryPanel — 执行轨迹详情面板（侧边栏紧凑版）
 *
 * 针对窄侧边栏窗口重新设计：
 * - 过滤器改为下拉选择，不占横向空间
 * - Stats 行改为网格布局，自动换行
 * - 每个 step 改为两行结构：第一行图标+类型+时间，第二行摘要
 * - 详情展开区改为全宽竖向堆叠
 *
 * 数据来源（双通道）：
 * 1. 优先从 TrajectoryService（ctx.get('uiTrajectory')）获取实时轨迹记录
 * 2. 回退到从 conversation messages 中提取工具调用和 LLM 交互记录
 */

import { memo, useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  ChevronDown, ChevronRight, Wrench, Brain, MessageSquare,
  CheckCircle2, AlertCircle, Clock,
  Cpu, Zap, Activity, Timer, Gauge, TrendingUp, Filter,
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
    case 'llm_call': return <Brain size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
    case 'tool_call': return <Wrench size={12} style={{ color: 'var(--info)', flexShrink: 0 }} />
    case 'tool_result': return <CheckCircle2 size={12} style={{ color: 'var(--success)', flexShrink: 0 }} />
    case 'user_input': return <MessageSquare size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
    case 'assistant_output': return <MessageSquare size={12} style={{ color: 'var(--text-primary)', flexShrink: 0 }} />
    case 'error': return <AlertCircle size={12} style={{ color: 'var(--error)', flexShrink: 0 }} />
    case 'turn_end': return <Activity size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
    default: return <Clock size={12} style={{ flexShrink: 0 }} />
  }
}

/** 类型标签 — 短标签版本 */
function typeLabel(type: TrajectoryStepType, zh: boolean): string {
  const labels: Record<TrajectoryStepType, { zh: string; en: string }> = {
    llm_call: { zh: 'LLM', en: 'LLM' },
    tool_call: { zh: '工具', en: 'Tool' },
    tool_result: { zh: '结果', en: 'Result' },
    user_input: { zh: '用户', en: 'User' },
    assistant_output: { zh: '助手', en: 'Asst' },
    error: { zh: '错误', en: 'Err' },
    turn_end: { zh: '轮次', en: 'Turn' },
  }
  return labels[type]?.[zh ? 'zh' : 'en'] || type
}

/** 格式化时间 — 紧凑 HH:MM */
function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
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

/** 从轨迹步骤推导 turn 级聚合指标 */
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
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
      unsubscribeRef.current = null
    }

    try {
      const ctx = tryGetCtx()
      if (!ctx) return
      const svc = (ctx as any).get('uiTrajectory')
      if (!svc) return

      if (sessionId) {
        const existing = svc.getSessionTrajectory?.(sessionId) || []
        if (existing.length > 0) setSteps(existing)
      }

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

/** 单个指标卡片 */
function MetricChip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 3,
      padding: '2px 6px',
      background: 'var(--bg-tertiary)',
      borderRadius: 4,
      fontSize: 'var(--fs-xs)',
      color: 'var(--text-muted)',
      whiteSpace: 'nowrap',
    }}>
      {icon}
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  )
}

/**
 * 执行轨迹详情面板 — 侧边栏紧凑版。
 * 针对窄窗口优化：竖向布局、下拉过滤器、网格指标。
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
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)

  const sessionId = useMemo(() => {
    if (messages && messages.length > 0) {
      const first = messages[0]
      return first?.sessionId || first?.session_id || null
    }
    return null
  }, [messages])

  const serviceSteps = useTrajectorySteps(sessionId)

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

  const turnMetrics = useMemo(() => deriveTurnMetrics(steps), [steps])

  const filterTypes: (TrajectoryStepType | 'all')[] = ['all', 'llm_call', 'tool_call', 'tool_result', 'assistant_output', 'error', 'turn_end']

  if (steps.length === 0) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        {zh ? '暂无执行轨迹' : 'No trajectory data'}
      </div>
    )
  }

  return (
    <div className="trajectory-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header — 紧凑单行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border-primary)',
          flexShrink: 0,
        }}
      >
        <Activity size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 'var(--fs-sm)', color: 'var(--text-primary)' }}>
          {zh ? '执行轨迹' : 'Trajectory'}
        </span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          ({filteredSteps.length})
        </span>

        {/* 过滤器 — 下拉选择，不占横向空间 */}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowFilterDropdown(!showFilterDropdown) }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--border-primary)',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--fs-xs)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <Filter size={10} />
            {filter === 'all' ? (zh ? '全部' : 'All') : typeLabel(filter as TrajectoryStepType, zh)}
            <ChevronDown size={9} />
          </button>
          {showFilterDropdown && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={(e) => { e.stopPropagation(); setShowFilterDropdown(false) }} />
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 2,
                minWidth: 100,
                zIndex: 100,
                padding: 4,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
              }}>
                {filterTypes.map(t => (
                  <div
                    key={t}
                    onClick={(e) => { e.stopPropagation(); setFilter(t); setShowFilterDropdown(false) }}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 'var(--fs-sm)',
                      background: filter === t ? 'var(--accent-alpha)' : 'transparent',
                      color: filter === t ? 'var(--accent)' : 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {t !== 'all' && <TypeIcon type={t as TrajectoryStepType} />}
                    <span>{t === 'all' ? (zh ? '全部' : 'All') : typeLabel(t as TrajectoryStepType, zh)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Stats — 网格布局自动换行 */}
      {turnMetrics.turns > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border-primary)',
          flexShrink: 0,
        }}>
          <MetricChip icon={<Timer size={10} />} label="" value={`${turnMetrics.turns}T · ${turnMetrics.steps}S`} />
          {turnMetrics.llmMs > 0 && <MetricChip icon={<Clock size={10} />} label="LLM" value={formatDuration(turnMetrics.llmMs)} />}
          {turnMetrics.toolMs > 0 && <MetricChip icon={<Wrench size={10} />} label="" value={formatDuration(turnMetrics.toolMs)} />}
          {turnMetrics.ttftSteps > 0 && turnMetrics.ttftMs > 0 && (
            <MetricChip icon={<Gauge size={10} />} label="TTFT" value={formatDuration(turnMetrics.ttftMs / turnMetrics.ttftSteps)} />
          )}
          {turnMetrics.decodeMs > 0 && turnMetrics.decodeTokens > 0 && (
            <MetricChip icon={<TrendingUp size={10} />} label="" value={`${formatTps(turnMetrics.decodeTokens / (turnMetrics.decodeMs / 1000))}t/s`} />
          )}
          {(turnMetrics.inputTokens > 0 || turnMetrics.outputTokens > 0) && (
            <MetricChip icon={<Zap size={10} />} label="" value={`${formatTokens(turnMetrics.inputTokens)}↓/${formatTokens(turnMetrics.outputTokens)}↑`} />
          )}
        </div>
      )}

      {/* Steps timeline — 竖向列表，全宽 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filteredSteps.map((step, idx) => {
          const isExpanded = expandedSteps.has(step.id)
          const hasDetail = step.data && (
            (typeof step.data.content === 'string' && step.data.content.length > 80) ||
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
                padding: '6px 10px',
                borderBottom: idx < filteredSteps.length - 1 ? '1px solid var(--border-primary)' : 'none',
              }}
            >
              {/* 第一行：图标 + 类型 + 补充信息 + 时间 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <TypeIcon type={step.type} />
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
                  {typeLabel(step.type, zh)}
                </span>
                {/* 工具名 */}
                {step.data?.name && (
                  <span style={{ fontFamily: 'monospace', fontSize: 'var(--fs-xs)', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {step.data.name}
                  </span>
                )}
                {/* LLM provider — 紧凑 */}
                {step.data?.provider && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>
                    <Cpu size={8} />{step.data.provider}
                  </span>
                )}
                {/* iteration */}
                {step.data?.iteration != null && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>
                    #{step.data.iteration}
                  </span>
                )}
                {/* 时间 — 右对齐 */}
                <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                  <Clock size={8} />
                  {formatTime(step.timestamp)}
                  {step.duration && <span>·{formatDuration(step.duration)}</span>}
                </span>
              </div>

              {/* 第二行：摘要内容 — 可换行 */}
              {step.data?.content && typeof step.data.content === 'string' && (
                <div
                  style={{
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--text-muted)',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    cursor: hasDetail ? 'pointer' : 'default',
                    wordBreak: 'break-word',
                  }}
                  onClick={() => hasDetail && toggleStep(step.id)}
                >
                  {step.data.content.slice(0, 200)}
                  {step.data.content.length > 200 && '...'}
                  {hasDetail && (isExpanded
                    ? <ChevronDown size={10} style={{ display: 'inline', marginLeft: 2, verticalAlign: 'text-bottom' }} />
                    : <ChevronRight size={10} style={{ display: 'inline', marginLeft: 2, verticalAlign: 'text-bottom' }} />)}
                </div>
              )}

              {/* error 摘要 */}
              {step.data?.error && !step.data?.content && (
                <div
                  style={{
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--error)',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    cursor: hasDetail ? 'pointer' : 'default',
                    wordBreak: 'break-word',
                  }}
                  onClick={() => hasDetail && toggleStep(step.id)}
                >
                  {step.data.error.slice(0, 200)}
                  {step.data.error.length > 200 && '...'}
                  {hasDetail && (isExpanded
                    ? <ChevronDown size={10} style={{ display: 'inline', marginLeft: 2, verticalAlign: 'text-bottom' }} />
                    : <ChevronRight size={10} style={{ display: 'inline', marginLeft: 2, verticalAlign: 'text-bottom' }} />)}
                </div>
              )}

              {/* result 摘要 */}
              {step.data?.result && !step.data?.content && (
                <div
                  style={{
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--text-muted)',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    cursor: hasDetail ? 'pointer' : 'default',
                    wordBreak: 'break-word',
                  }}
                  onClick={() => hasDetail && toggleStep(step.id)}
                >
                  {typeof step.data.result === 'string' ? step.data.result.slice(0, 200) : JSON.stringify(step.data.result).slice(0, 200)}
                  {'...'}
                  {hasDetail && (isExpanded
                    ? <ChevronDown size={10} style={{ display: 'inline', marginLeft: 2, verticalAlign: 'text-bottom' }} />
                    : <ChevronRight size={10} style={{ display: 'inline', marginLeft: 2, verticalAlign: 'text-bottom' }} />)}
                </div>
              )}

              {/* token usage 行 — 独立小行 */}
              {step.data?.usage && !isExpanded && (
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Zap size={8} />
                  {formatTokens(step.data.usage.promptTokens || step.data.usage.inputTokens || 0)}↓
                  {' '}
                  {formatTokens(step.data.usage.completionTokens || step.data.usage.outputTokens || 0)}↑
                </div>
              )}

              {/* 展开详情 — 全宽竖向堆叠 */}
              {isExpanded && step.data && (
                <div style={{
                  marginTop: 4,
                  padding: 8,
                  background: 'var(--bg-tertiary)',
                  borderRadius: 4,
                  fontSize: 'var(--fs-xs)',
                  lineHeight: 1.5,
                  maxHeight: 250,
                  overflowY: 'auto',
                }}>
                  {/* LLM usage */}
                  {step.data.usage && (
                    <div style={{ marginBottom: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        <strong>Prompt:</strong> {formatTokens(step.data.usage.promptTokens || step.data.usage.inputTokens || 0)}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        <strong>Completion:</strong> {formatTokens(step.data.usage.completionTokens || step.data.usage.outputTokens || 0)}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        <strong>Total:</strong> {formatTokens(step.data.usage.totalTokens || 0)}
                      </span>
                    </div>
                  )}
                  {/* provider/model */}
                  {step.data.provider && (
                    <div style={{ marginBottom: 4, color: 'var(--text-muted)' }}>
                      <strong>Provider:</strong> {step.data.provider}
                      {step.data.model && <span> · <strong>Model:</strong> {step.data.model}</span>}
                    </div>
                  )}
                  {/* args */}
                  {step.data.args && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}><strong>Args:</strong></div>
                      <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                        {typeof step.data.args === 'string' ? step.data.args : JSON.stringify(step.data.args, null, 2)}
                      </pre>
                    </div>
                  )}
                  {/* content */}
                  {step.data.content && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}><strong>Content:</strong></div>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-muted)' }}>
                        {step.data.content}
                      </div>
                    </div>
                  )}
                  {/* result */}
                  {step.data.result && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}><strong>Result:</strong></div>
                      <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                        {typeof step.data.result === 'string' ? step.data.result : JSON.stringify(step.data.result, null, 2)}
                      </pre>
                    </div>
                  )}
                  {/* error */}
                  {step.data.error && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ color: 'var(--error)', marginBottom: 2 }}><strong>Error:</strong></div>
                      <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--error)' }}>
                        {step.data.error}
                      </pre>
                    </div>
                  )}
                  {/* turn_end */}
                  {step.data.reason && (
                    <div style={{ color: 'var(--text-muted)' }}>
                      <strong>Stop:</strong> {step.data.reason}
                      {step.data.duration_ms && <span> · <strong>Duration:</strong> {formatDuration(step.data.duration_ms)}</span>}
                      {step.data.iterations != null && <span> · <strong>Iterations:</strong> {step.data.iterations}</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})
