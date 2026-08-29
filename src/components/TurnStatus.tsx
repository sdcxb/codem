/**
 * TurnStatus — 助手 turn 级状态行
 *
 * 对标 DSH ui-conversation/src/client/chat/MessageItem.tsx 中的：
 * - TurnErrorItem: 持久化 turn 错误通知（红色 StateDot + 消息 + 错误码）
 * - TurnMaxTokensItem: 达到输出 token 上限通知（黄色 StateDot + 提示）
 * - ModelRetryItem: 模型重试倒计时通知（可折叠详情）
 *
 * 这些是持久化在对话流中的 turn 级状态，不是临时 toast。
 */

import { memo, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, AlertTriangle, RotateCw, Clock, ChevronDown, ChevronRight,
} from 'lucide-react'
import { useLang } from '../core/i18n/lang'

export type TurnStatusKind = 'error' | 'max-tokens' | 'retry'

export interface TurnStatusProps {
  kind: TurnStatusKind
  /** 错误消息（error 状态使用） */
  message?: string
  /** 错误码（error 状态使用） */
  code?: string
  /** 重试信息（retry 状态使用） */
  retry?: {
    retry: number
    maxRetries: number
    delayMs: number
    failure?: string
    active: boolean
  }
}

/** 计算重试剩余秒数 */
function retrySeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1_000))
}

/** TurnError 通知行 — 持久化的终端错误 */
const TurnErrorRow = memo(function TurnErrorRow({
  message, code,
}: { message?: string; code?: string }) {
  const lang = useLang()
  const zh = lang === 'zh'
  return (
    <div
      className="turn-status-row turn-error"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 6,
        background: 'rgba(239, 68, 68, 0.08)',
        border: '1px solid rgba(239, 68, 68, 0.2)',
        fontSize: 12,
      }}
    >
      <AlertCircle size={13} style={{ color: 'var(--error)', flexShrink: 0, marginTop: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: 'var(--error)' }}>
          {zh ? '执行出错' : 'Turn Error'}
        </span>
        {message && (
          <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
            {message}
          </span>
        )}
      </div>
      {code && (
        <code style={{
          fontSize: 10,
          padding: '1px 4px',
          borderRadius: 3,
          background: 'rgba(239, 68, 68, 0.15)',
          color: 'var(--error)',
          flexShrink: 0,
        }}>
          {code}
        </code>
      )}
    </div>
  )
})

/** MaxTokens 通知行 — 输出达到 token 上限 */
const TurnMaxTokensRow = memo(function TurnMaxTokensRow() {
  const lang = useLang()
  const zh = lang === 'zh'
  return (
    <div
      className="turn-status-row turn-max-tokens"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 6,
        background: 'rgba(234, 179, 8, 0.08)',
        border: '1px solid rgba(234, 179, 8, 0.2)',
        fontSize: 12,
      }}
    >
      <AlertTriangle size={13} style={{ color: 'var(--warning, #eab008)', flexShrink: 0, marginTop: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontWeight: 600, color: 'var(--warning, #eab008)' }}>
          {zh ? '已达到输出上限' : 'Max Tokens Reached'}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          {zh ? '回复被截断，可通过继续指令让模型补全。' : 'Response was truncated. Use continue to let the model finish.'}
        </span>
      </div>
    </div>
  )
})

/** ModelRetry 通知行 — 重试倒计时（可折叠详情） */
const ModelRetryRow = memo(function ModelRetryRow({
  retry, maxRetries, delayMs, failure, active,
}: {
  retry: number
  maxRetries: number
  delayMs: number
  failure?: string
  active: boolean
}) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [expanded, setExpanded] = useState(false)

  // 倒计时
  const deadline = useMemo(() => Date.now() + delayMs, [delayMs, retry])
  const scheduledSeconds = retrySeconds(delayMs)
  const [remaining, setRemaining] = useState(scheduledSeconds)

  useEffect(() => {
    if (!active) return
    const update = () => {
      const next = retrySeconds(deadline - Date.now())
      setRemaining(prev => prev !== next ? next : prev)
      return next
    }
    if (update() === 1) return
    const timer = window.setInterval(() => {
      if (update() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const maximum = maxRetries === Infinity ? '∞' : maxRetries
  const seconds = active ? remaining : scheduledSeconds

  const label = active
    ? (zh ? '正在重试' : 'Retrying')
    : (zh ? '已调度重试' : 'Retry scheduled')

  return (
    <details
      className="turn-status-row turn-retry"
      data-active={active || undefined}
      style={{
        padding: '6px 10px',
        borderRadius: 6,
        background: 'rgba(99, 102, 241, 0.08)',
        border: '1px solid rgba(99, 102, 241, 0.2)',
        fontSize: 12,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          listStyle: 'none',
        }}
      >
        {expanded
          ? <ChevronDown size={12} style={{ flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ flexShrink: 0 }} />
        }
        <RotateCw size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} className={active ? 'spin' : ''} />
        <span role="status" style={{ color: 'var(--text-secondary)' }}>
          {zh
            ? `${label} · 第 ${retry}/${maximum} 次 · ${seconds}s`
            : `${label} · retry ${retry}/${maximum} · ${seconds}s`
          }
        </span>
      </summary>
      {expanded && (
        <div style={{ marginTop: 4, padding: '4px 0 0 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>
              {zh ? '延迟' : 'Delay'}:
            </span>
            <span style={{ fontSize: 11 }}> {Math.round(delayMs)}ms</span>
          </div>
          {failure && (
            <div>
              <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>
                {zh ? '失败原因' : 'Failure'}:
              </span>
              <span style={{ fontSize: 11, color: 'var(--error)' }}> {failure}</span>
            </div>
          )}
        </div>
      )}
    </details>
  )
})

/** TurnStatus — 统一入口，按 kind 路由到对应行 */
export const TurnStatus = memo(function TurnStatus(props: TurnStatusProps) {
  switch (props.kind) {
    case 'error':
      return <TurnErrorRow message={props.message} code={props.code} />
    case 'max-tokens':
      return <TurnMaxTokensRow />
    case 'retry':
      if (!props.retry) return null
      return (
        <ModelRetryRow
          retry={props.retry.retry}
          maxRetries={props.retry.maxRetries}
          delayMs={props.retry.delayMs}
          failure={props.retry.failure}
          active={props.retry.active}
        />
      )
    default:
      return null
  }
})
