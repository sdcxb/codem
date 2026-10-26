/**
 * ReasoningRow — 助手推理/思考折叠行
 *
 * 2026-10-26（第 205 轮）：对齐 DSH 的「单行 + 段落级摘要」，而不是 OMP 的 per-think 卡片。
 * 关键约束：
 * - 一条 assistant 消息只有一个 reasoning block；不按空行伪造时间线。
 * - 折叠态固定 24px、body 不挂载；流式摘要用「最近一个已完成段落的首行」。
 * - 展开态才挂 body，按 64 行/4096 字符分块，块用 content-visibility 跳过离屏布局。
 * - 不在 summary 行上挂 ResizeObserver，避免 Codex #33996 那类布局反馈循环。
 */

import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Brain } from 'lucide-react'
import { useLang } from '../core/i18n/lang'

/** 提取首行 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * 最近一个「已完成段落」的首行。
 *
 * 与 latestLine 的差别：流式时一行只写了一半也不换摘要，等段落换行完成后再换，
 * 避免摘要每 100ms 横向抖动。段落以「空行」分隔；段落内第一行作为摘要。
 */
export function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g

  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null
      ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

const CHUNK_LINES = 64
const CHUNK_CHARS = 4096

/** 把 reasoning 切成稳定的块：已完成块的字符串不变，React 只更新尾块。 */
export function splitReasoningChunks(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let chars = 0

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
      chars = 0
    }
  }

  for (const line of lines) {
    if (current.length >= CHUNK_LINES || (current.length > 0 && chars + line.length > CHUNK_CHARS)) {
      flush()
    }
    current.push(line)
    chars += line.length + 1
  }
  flush()
  return chunks
}

const ReasoningChunk = memo(function ReasoningChunk({
  text,
  running,
  last,
}: {
  text: string
  running: boolean
  last: boolean
}) {
  return (
    <div className="reasoning-chunk">
      {text}
      {running && last && <span className="reasoning-cursor" aria-hidden />}
    </div>
  )
})

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
  const [expanded, setExpanded] = useState(false)
  const [following, setFollowing] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyId = useId()

  const summary = useMemo(
    () => (running ? latestCompletedParagraphFirstLine(text) : firstLine(text)),
    [running, text],
  )

  const chunks = useMemo(
    () => (expanded ? splitReasoningChunks(text) : []),
    [expanded, text],
  )

  useEffect(() => {
    if (!expanded || !running || !following) return
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = body.scrollHeight
  }, [expanded, running, following, text])

  const onBodyScroll = () => {
    const body = bodyRef.current
    if (!body) return
    setFollowing(body.scrollHeight - body.scrollTop - body.clientHeight < 24)
  }

  return (
    <div
      className="reasoning-row"
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => {
          if (!expanded) setFollowing(true)
          setExpanded((value) => !value)
        }}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        {expanded
          ? <ChevronDown size={12} className="reasoning-chev" aria-hidden />
          : <ChevronRight size={12} className="reasoning-chev" aria-hidden />
        }
        <Brain
          size={14}
          className={running ? 'reasoning-icon reasoning-icon-streaming' : 'reasoning-icon'}
          aria-hidden
        />
        <span className="reasoning-title">
          {running
            ? (zh ? '思考中...' : 'Thinking...')
            : (zh ? '思考' : 'Think')
          }
        </span>
        {!running && text.length > 0 && (
          <span className="reasoning-meta">
            · {text.length} {zh ? '字' : 'chars'}
          </span>
        )}
        <span className="reasoning-separator" aria-hidden>·</span>
        <span className="reasoning-summary">
          {summary || (zh ? '（无摘要）' : '(no summary)')}
        </span>
      </button>

      {expanded && (
        <div
          className="reasoning-body"
          id={bodyId}
          ref={bodyRef}
          role="region"
          aria-label={zh ? '思考过程' : 'Reasoning'}
          onScroll={onBodyScroll}
        >
          {chunks.map((chunk, index) => (
            <ReasoningChunk
              key={index}
              text={chunk}
              running={running}
              last={index === chunks.length - 1}
            />
          ))}
          {running && !following && (
            <button
              type="button"
              className="reasoning-jump"
              onClick={() => {
                setFollowing(true)
                const body = bodyRef.current
                if (body) body.scrollTop = body.scrollHeight
              }}
            >
              {zh ? '回到最新' : 'Jump to latest'}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
