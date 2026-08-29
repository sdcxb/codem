/**
 * ReasoningRow — 助手推理/思考折叠行
 *
 * 对标 DSH ui-conversation/src/client/chat/ReasoningRow.tsx
 *
 * 设计：
 * - 折叠时：显示首行（已结束）或最新行（流式时）
 * - 流式时：自动滚动摘要到最新行
 * - 展开：灰底缩进文本体
 * - Think 图标 + 标题 + 分隔符 + 摘要
 */

import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Brain } from 'lucide-react'
import { useLang } from '../core/i18n/lang'

/** 提取首行 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** 提取最后一行（去除尾部空格后） */
function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

export interface ReasoningRowProps {
  /** 完整或流式的推理文本 */
  text: string
  /** 是否正在流式输出 */
  running?: boolean
}

export const ReasoningRow = memo(function ReasoningRow({
  text,
  running = false,
}: ReasoningRowProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [expanded, setExpanded] = useState(running ? true : false)
  const summaryRef = useRef<HTMLSpanElement>(null)

  // 流式时显示最新行，已结束时显示首行
  const summary = running ? latestLine(text) : firstLine(text)

  // 流式时自动滚动摘要到末尾
  useEffect(() => {
    if (!running) return
    const element = summaryRef.current
    if (element === null) return
    // 用 rAF 确保 DOM 更新后再滚动
    const raf = requestAnimationFrame(() => {
      element.scrollLeft = element.scrollWidth - element.clientWidth
    })
    return () => cancelAnimationFrame(raf)
  }, [running, summary])

  return (
    <div
      className="reasoning-row"
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
    >
      {/* 折叠行 */}
      <button
        className="reasoning-toggle"
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '4px 0',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          color: 'var(--text-secondary)',
          textAlign: 'left',
        }}
      >
        {expanded
          ? <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
          : <ChevronRight size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
        }
        <Brain
          size={13}
          className={running ? 'reasoning-icon-streaming' : ''}
          style={{
            flexShrink: 0,
            color: running ? 'var(--accent)' : 'var(--text-muted)',
            animation: running ? 'pulse 2s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ fontWeight: 600, flexShrink: 0 }}>
          {running
            ? (zh ? '思考中...' : 'Thinking...')
            : (zh ? '思考' : 'Think')
          }
        </span>
        {!running && text.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
            · {text.length} {zh ? '字' : 'chars'}
          </span>
        )}
        {/* 分隔符 */}
        <span aria-hidden style={{ opacity: 0.3, margin: '0 2px' }}>·</span>
        {/* 摘要：水平滚动，溢出省略 */}
        <span
          ref={summaryRef}
          className="reasoning-summary"
          data-follow-end={running || undefined}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11,
            color: 'var(--text-muted)',
            opacity: 0.8,
          }}
        >
          {summary || (zh ? '(空)' : '(empty)')}
        </span>
      </button>

      {/* 展开体 — 灰底缩进 */}
      {expanded && (
        <div
          className="reasoning-body"
          style={{
            marginLeft: 18,
            padding: '8px 12px',
            background: 'var(--bg-tertiary)',
            borderRadius: 6,
            borderLeft: '2px solid var(--border-primary)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 400,
            overflowY: 'auto',
            lineHeight: 1.6,
          }}
        >
          {text}
          {running && <span className="reasoning-cursor" style={{
            display: 'inline-block',
            width: 6,
            height: 13,
            background: 'var(--accent)',
            marginLeft: 2,
            animation: 'blink 1s step-end infinite',
            verticalAlign: 'text-bottom',
          }} />}
        </div>
      )}
    </div>
  )
})
