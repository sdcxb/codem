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
 * 数据来源：从 conversation messages 中提取工具调用和 LLM 交互记录
 */

import { memo, useState, useMemo, useEffect, useCallback } from 'react'
import {
  ChevronDown, ChevronRight, Wrench, Brain, MessageSquare,
  CheckCircle2, XCircle, LoaderCircle, AlertCircle, Clock, Filter,
} from 'lucide-react'
import { useLang } from '../core/i18n/lang'

/** 轨迹步骤类型 */
export type TrajectoryStepType =
  | 'llm_call'
  | 'tool_call'
  | 'tool_result'
  | 'user_input'
  | 'assistant_output'
  | 'error'

/** 轨迹步骤 */
export interface TrajectoryStep {
  id: string
  type: TrajectoryStepType
  data: any
  timestamp: number
  duration?: number
}

export interface TrajectoryPanelProps {
  /** 轨迹步骤列表 */
  steps?: TrajectoryStep[]
  /** 从消息列表加载轨迹（可选） */
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

/** 从消息列表提取轨迹步骤 */
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

/**
 * 执行轨迹详情面板。
 * 以时间线形式展示 Agent 每步执行轨迹。
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

  const steps = useMemo(() => {
    if (providedSteps && providedSteps.length > 0) return providedSteps
    if (messages && messages.length > 0) return extractStepsFromMessages(messages)
    return []
  }, [providedSteps, messages])

  const filteredSteps = useMemo(() => {
    if (filter === 'all') return steps
    return steps.filter(s => s.type === filter)
  }, [steps, filter])

  const toggleStep = (id: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (steps.length === 0) return null

  const filterTypes: (TrajectoryStepType | 'all')[] = ['all', 'llm_call', 'tool_call', 'tool_result', 'assistant_output', 'error']

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
        <Brain size={13} />
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

      {/* Steps timeline */}
      {expanded && (
        <div style={{ maxHeight: 400, overflowY: 'auto', padding: '0 12px 8px' }}>
          {filteredSteps.map((step, idx) => {
            const isExpanded = expandedSteps.has(step.id)
            const hasDetail = step.data && (
              (typeof step.data.content === 'string' && step.data.content.length > 100) ||
              step.data.args ||
              step.data.result
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
