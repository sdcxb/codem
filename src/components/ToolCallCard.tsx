/**
 * ToolCallCard — 工具调用行卡片（桌面专用明细的注入方）
 *
 * 第 2 步之后**胶囊行本身**只有一份实现：`packages/ui/src/tool-card.tsx`（`ToolCardView`）。
 * 本文件只负责桌面才有的**专用明细**：
 * - Terminal / Diff / Read / Search / WebSearch 卡片（结构化 metadata 推导）；
 * - `metadata.file_paths` 可点击文件链接；
 * - 溢出全文（spill）入口与查看弹窗。
 *
 * 通用工具（没有专用明细）直接走共享的 IN/OUT，桌面不再有第二份实现。
 */

import { memo, useState, useMemo, type ReactNode } from "react";
import { findSpillLocator, readSpillText } from "../core/storage/spill";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import {
  Wrench, CheckCircle2, XCircle, LoaderCircle,
  ChevronDown, ChevronRight,
  FileText, Search, Terminal as TerminalIcon, FileEdit, FolderSearch, Bot,
  ExternalLink, Globe, Code2, Sparkles, Files,
} from "lucide-react";
import { handleFileLinkClick, handleFileLinkContextMenu } from "../utils/file-link";
import { DiffBlockCard, type DiffHunk } from "./DiffBlockCard";
import { ToolCardView, classifyTool, deriveFilePath } from "../../packages/ui/src/tool-card";

// ====== 类型定义 ======

/** 桌面工具卡入参（对外导出兼容：`ToolCallGroup` / `MessageBubble` / 判据都从这里取） */
export interface ToolCallCardProps {
  toolName: string;
  toolArgs?: string;
  toolResult?: string;
  status: "running" | "done" | "error";
  duration?: number;
  /** 参数摘要（用于卡片头部显示） */
  argsSummary?: string;
  /** 结构化元数据（用于专用卡片渲染） */
  metadata?: Record<string, any>;
}

// ====== 专用卡片：Terminal ======

interface TerminalCardModel {
  command: string
  cwd?: string
  output?: string
  exitCode?: number
  signal?: string
  running: boolean
}

function tryTerminalModel(
  argsRaw: string,
  result: string | undefined,
  status: string,
  metadata?: Record<string, any>,
): TerminalCardModel | null {
  try {
    const parsed = argsRaw ? JSON.parse(argsRaw) : {}
    const cmd = parsed.command || parsed.cmd || parsed.text || ''
    if (!cmd) return null
    const isRunning = status === 'running'
    let exitCode: number | undefined
    let signal: string | undefined
    // 优先使用结构化 metadata（terminal_send 返回 viewport/waitReason/sessionStatus）
    const sessionStatus = metadata?.sessionStatus
    if (sessionStatus?.kind === 'exited') {
      exitCode = sessionStatus.exitCode ?? undefined
      signal = sessionStatus.signal ?? undefined
    }
    // 无 metadata 时回退到文本解析
    if (exitCode === undefined && signal === undefined && result && !isRunning) {
      const exitMatch = result.match(/(?:exit|code)[:\s]+(\d+)/i)
      if (exitMatch) exitCode = parseInt(exitMatch[1])
      const sigMatch = result.match(/(?:signal|sig)[:\s]+(\w+)/i)
      if (sigMatch) signal = sigMatch[1]
    }
    return {
      command: cmd,
      cwd: parsed.cwd,
      output: metadata?.viewport || result || undefined,
      exitCode,
      signal,
      running: isRunning || (metadata?.sessionStatus?.kind === 'running' && status !== 'error'),
    }
  } catch {
    return null
  }
}


const TERMINAL_MAX_LINES = 16

function TerminalBlock({ model }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = () => {
    if (!model.output) return
    navigator.clipboard.writeText(model.output).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // 输出行数折叠：超过 16 行显示首尾 + 展开按钮（对标 dsh TerminalBlock headTailCap）
  const outputLines = model.output ? model.output.split('\n') : []
  const capped = outputLines.length > TERMINAL_MAX_LINES && !expanded
  const headCount = Math.ceil(TERMINAL_MAX_LINES / 2)
  const tailCount = TERMINAL_MAX_LINES - headCount
  const hidden = outputLines.length - TERMINAL_MAX_LINES
  const visibleLines = capped
    ? [...outputLines.slice(0, headCount), `… 其余 ${hidden} 行`, ...outputLines.slice(outputLines.length - tailCount)]
    : outputLines

  return (
    <div className="tool-card terminal-block">
      {/* Prompt 行 */}
      <div className="tool-card-head">
        <TerminalIcon size={12} className="tool-card-head-icon" />
        <span className="hint-sm">
          {model.cwd ? model.cwd.split(/[\\/]/).pop() + '$' : '$'}
        </span>
        <code className="tool-card-command">
          {model.command}
        </code>
        {model.running ? (
          <span className="tool-card-status tool-card-status--running">
            <LoaderCircle size={10} className="tool-pill-icon-spin icon-inline" /> running
          </span>
        ) : model.exitCode !== undefined && model.exitCode !== 0 ? (
          <span className="tool-card-status tool-card-status--error">
            exit {model.exitCode}
          </span>
        ) : model.signal ? (
          <span className="tool-card-status tool-card-status--error">
            {model.signal}
          </span>
        ) : (
          <span className="tool-card-status tool-card-status--done">
            done
          </span>
        )}
        {model.output && !model.running && (
          <button
            type="button"
            onClick={onCopy}
            className="tool-card-copy"
            title={copied ? '已复制' : '复制输出'}
          >
            {copied ? '✓' : '复制'}
          </button>
        )}
      </div>
      {/* Output */}
      {model.output && (
        <pre className="tool-card-pre">
          {visibleLines.join('\n').slice(0, 2000)}
          {model.output.length > 2000 && !capped && '\n... (truncated)'}
        </pre>
      )}
      {capped && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="tool-card-expand"
        >
          展开全部输出
        </button>
      )}
    </div>
  )
}

// ====== 专用卡片：Diff ======

function tryDiffModel(metadata: any, result: string | undefined): DiffHunk[] | null {
  // 从 metadata.diff 或 result 中解析 diff
  if (metadata?.diff && Array.isArray(metadata.diff)) {
    return metadata.diff
  }
  // 尝试从 result 中解析 unified diff
  if (result && result.includes('---') && result.includes('+++')) {
    return [{ path: 'file', oldText: null, newText: result }]
  }
  return null
}

// ====== 专用卡片：Read (行号 + 内容) ======

function tryReadModel(metadata: any, result: string | undefined): { path: string; content: string } | null {
  if (metadata?.path || metadata?.file_path) {
    return { path: metadata.path || metadata.file_path, content: result || '' }
  }
  // 从 result 中推断文件读取
  if (result && result.match(/^\s*\d+\s*│/m)) {
    return { path: 'file', content: result }
  }
  return null
}

function ReadBlockCard({ path, content }: { path: string; content: string }) {
  const lines = content.split('\n').slice(0, 50)
  return (
    <div className="tool-card tool-card--scroll read-block">
      <div className="tool-card-head">
        <FileText size={12} /> {path}
      </div>
      <pre className="tool-card-pre tool-card-pre--tight tool-card-pre--plain">
        {lines.map((line, i) => (
          <div key={i} className="read-row">
            <span className="line-num">
              {i + 1}
            </span>
            <span className="line-text">
              {line || ' '}
            </span>
          </div>
        ))}
        {content.split('\n').length > 50 && (
          <div className="read-more">
            ... ({content.split('\n').length - 50} more lines)
          </div>
        )}
      </pre>
    </div>
  )
}

// ====== 专用卡片：Search (grep/glob 结果分组) ======

/**
 * 输出契约是「`路径:行号:内容`」或「纯路径列表」的工具 —— **只有 grep / glob**。
 *
 * 这里原先写的是 `lower.includes('search')`，于是 `web_search` 与 `search_notebook`
 * 也被放了进来：只要报告里出现一行 `x:数字:y` 形状的文本，整张卡片就被渲染成
 * 「假的文件 + N match」，而排在它后面的专用卡片（`WebSearchResultCard`）**永远到不了**。
 * 真机取证（2026-10-17）里触发它的是 DeepSeek Search 的元数据行
 * `站点: … · 日期: 2026-10-17T09:12:12.122Z`（`T09:12:12` 被读成「09 行」）。
 * 判据：`WEBSEARCH-CARD-1/2/3`。
 *
 * 用**精确 id 白名单**而不是"排除 web_search"：下次再加一个名字带 search 的工具时，
 * 默认落到通用卡片（正确的那一边），而不是默认落到猜形状的分支里。
 */
const FILE_SHAPE_SEARCH_TOOLS = new Set(['grep', 'glob'])

function trySearchModel(toolName: string, result: string | undefined): { kind: 'matches' | 'paths'; files?: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>; paths?: string[] } | null {
  if (!result) return null
  const lower = toolName.toLowerCase()
  if (!FILE_SHAPE_SEARCH_TOOLS.has(lower)) return null

  // 尝试解析为 grep 输出（file:line:content 或 file:line: ）
  const lines = result.split('\n').filter(l => l.trim())
  const files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }> = []
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/)
    if (m) {
      const [, path, num, content] = m
      let file = files.find(f => f.path === path)
      if (!file) {
        file = { path, matches: [] }
        files.push(file)
      }
      file.matches.push({ lineNumber: parseInt(num), line: content })
    }
  }
  if (files.length > 0) return { kind: 'matches', files }

  // 尝试作为 paths 列表
  if (lines.length > 0 && lines.every(l => !l.includes(':') || l.match(/^\s*\S+\s*$/))) {
    return { kind: 'paths', paths: lines.slice(0, 100) }
  }
  return null
}

function SearchBlockCard({ model }: { model: { kind: 'matches' | 'paths'; files?: any[]; paths?: string[] } }) {
  return (
    <div className="tool-card tool-card--scroll search-block">
          {model.kind === 'matches' && model.files?.map((file, fi) => (
            <div key={fi} className="tool-card-row">
          <div className="tool-card-head tool-card-head--accent">
            <FolderSearch size={12} /> {file.path}
            <span className="tool-card-count">
              · {file.matches.length} match{file.matches.length > 1 ? 'es' : ''}
            </span>
          </div>
          {file.matches.slice(0, 8).map((m: any, mi: number) => (
            <div key={mi} className="search-match-row">
              <span className="line-num line-num--wide">
                {m.lineNumber}
              </span>
              <span className="search-match-text">
                {m.line}
              </span>
            </div>
          ))}
          {file.matches.length > 8 && (
            <div className="search-match-more">
              ... {file.matches.length - 8} more
            </div>
          )}
        </div>
      ))}
      {model.kind === 'paths' && model.paths && (
        <div className="search-paths">
          {model.paths.map((p, pi) => (
            <div key={pi} className="search-path">
              {p}
            </div>
          ))}
          {model.paths.length === 100 && (
            <div className="search-path-more">
              ... (truncated at 100 paths)
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ====== WebSearchResultCard（已有，保留并改进） ======

function WebSearchResultCard({ output }: { output: string }) {
  const searchResults = useMemo(() => {
    const results: Array<{ title: string; url: string; snippet: string }> = []
    const blocks = output.split(/### \d+\./).slice(1)
    for (const block of blocks) {
      const titleMatch = block.match(/^(.+?)(?:\n|$)/)
      const urlMatch = block.match(/URL:\s*(.+)/)
      const snippetMatch = block.match(/Snippet:\s*(.+?)(?:\n|$)/)
      if (titleMatch || urlMatch) {
        results.push({
          title: (titleMatch?.[1] || '').trim(),
          url: (urlMatch?.[1] || '').trim(),
          snippet: (snippetMatch?.[1] || '').trim(),
        })
      }
    }
    return results
  }, [output])

  const sourceMatch = output.match(/\[Search source:\s*(.+?)\]/)
  const source = sourceMatch?.[1] || ''
  const queryMatch = output.match(/Found \d+ results for "([^"]+)"/)
  const query = queryMatch?.[1] || ''

  if (searchResults.length === 0) {
    return (
      <div className="tool-pill-detail-section">
        <span className="tool-pill-detail-label">Result</span>
        <pre className="tool-pill-detail-code">{output}</pre>
      </div>
    )
  }

  return (
    <div className="tool-pill-detail-section">
      <div className="websearch-head">
        <Globe size={12} className="websearch-icon" />
        <span className="tool-pill-detail-label tool-pill-detail-label--flush">
          {query ? `Search: "${query}"` : 'Web Search'}
        </span>
        {source && <span className="websearch-source">· {source}</span>}
        <span className="websearch-source">· {searchResults.length} results</span>
      </div>
      <div className="websearch-list">
        {searchResults.map((result, idx) => (
          <div key={idx} className="websearch-item">
            <div className="websearch-item-row">
              <span className="websearch-index">{idx + 1}.</span>
              {result.url ? (
                <a href={result.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="websearch-title websearch-title--link">
                  {result.title || result.url}
                  <ExternalLink size={10} className="icon-shrink-none" />
                </a>
              ) : (
                <span className="websearch-title">
                  {result.title}
                </span>
              )}
            </div>
            {result.snippet && (
              <span className="websearch-snippet">
                {result.snippet}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ====== 主组件：ToolCallCard ======

export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  toolArgs,
  toolResult,
  status,
  duration,
  argsSummary,
  metadata,
}: ToolCallCardProps) {
  const [spillOpen, setSpillOpen] = useState(false)
  const [spillText, setSpillText] = useState<string | null>(null)
  const [spillError, setSpillError] = useState<string | null>(null)
  const [spillLoading, setSpillLoading] = useState(false)
  const spillLocator = useMemo(() => findSpillLocator(toolResult), [toolResult])
  useDismissableLayer({ open: spillOpen, onDismiss: () => setSpillOpen(false) })

  const openSpill = async () => {
    if (!spillLocator) return
    setSpillOpen(true)
    setSpillLoading(true)
    setSpillError(null)
    setSpillText(null)
    try {
      setSpillText(await readSpillText(spillLocator))
    } catch (e) {
      setSpillError(e instanceof Error ? e.message : String(e))
    } finally {
      setSpillLoading(false)
    }
  }

  const variant = useMemo(() => classifyTool(toolName), [toolName])
  // 文件路径
  const filePath = useMemo(() => deriveFilePath(variant, toolArgs || ''), [variant, toolArgs])

  // 结构化文件路径（来自工具返回的 metadata.file_paths）
  const metadataFilePaths = useMemo(() => {
    const fps = metadata?.file_paths as string[] | undefined;
    if (!Array.isArray(fps) || fps.length === 0) return null;
    // 如果和 args 中的 file_path 重复，去重
    const set = new Set(fps);
    if (filePath) set.delete(filePath);
    const unique = Array.from(set);
    return unique.length > 0 ? unique : null;
  }, [metadata, filePath]);

  // 专用卡片推导（桌面专有能力：Terminal/Diff/Read/Search/Web 的结构化明细）
  const terminalModel = useMemo(() => {
    if (variant !== 'bash') return null
    return tryTerminalModel(toolArgs || '', toolResult, status, metadata)
  }, [variant, toolArgs, toolResult, status, metadata])

  const diffHunks = useMemo(() => {
    if (variant !== 'write' && variant !== 'edit') return null
    return tryDiffModel(metadata, toolResult)
  }, [variant, metadata, toolResult])

  const readModel = useMemo(() => {
    if (variant !== 'read') return null
    return tryReadModel(metadata, toolResult)
  }, [variant, metadata, toolResult])

  const searchModel = useMemo(() => {
    if (variant !== 'search') return null
    return trySearchModel(toolName, toolResult)
  }, [variant, toolName, toolResult])

  const isWebSearch = toolName.toLowerCase() === 'web_search'

  /**
   * 专用明细：有就交给共享工具卡渲染（`detail` 优先于通用 IN/OUT）。
   * 通用工具不传 ⇒ 共享卡渲染 IN/OUT —— 桌面不再有第二份实现。
   */
  const detail = terminalModel !== null ? (
    <TerminalBlock model={terminalModel} />
  ) : diffHunks !== null ? (
    <DiffBlockCard hunks={diffHunks} />
  ) : readModel !== null ? (
    <ReadBlockCard path={readModel.path} content={readModel.content} />
  ) : searchModel !== null ? (
    <SearchBlockCard model={searchModel} />
  ) : isWebSearch && toolResult ? (
    <WebSearchResultCard output={toolResult} />
  ) : undefined

  /* 明细下方的附加区（文件路径链接 / 溢出全文入口）—— 需要宿主的文件系统能力 */
  const extras = metadataFilePaths || spillLocator ? (
    <>
      {/* 结构化文件路径列表 — 来自工具返回的 metadata.file_paths */}
      {metadataFilePaths && (
        <div className="tool-io-card tool-io-card--stacked">
          <div className="tool-io-section">
            <span className="tool-io-label tool-io-label--icon"><Files size={10} /></span>
            <div className="tool-io-paths">
              {metadataFilePaths.map((p, i) => (
                <a
                  key={i}
                  href={p}
                  onClick={(e) => handleFileLinkClick(e, p)}
                  onContextMenu={(e) => handleFileLinkContextMenu(e, p)}
                  title={`点击打开: ${p}`}
                  className="tool-io-file-link"
                >
                  {p}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
      {spillLocator && (
        <button
          type="button"
          className="spill-viewer-open"
          onClick={(e) => { e.stopPropagation(); void openSpill() }}
        >
          查看溢出全文
        </button>
      )}
    </>
  ) : undefined

  return (
    <>
      <ToolCardView
        toolName={toolName}
        toolArgs={toolArgs}
        toolResult={toolResult}
        status={status}
        duration={duration}
        argsSummary={argsSummary}
        metadata={metadata}
        detail={detail}
        extras={extras}
      />

      {spillOpen && (
        <div className="modal-overlay spill-viewer-overlay" role="presentation" onClick={() => setSpillOpen(false)}>
          <div
            className="modal-editor spill-viewer-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="溢出全文"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="spill-viewer-head">
              <strong>溢出全文</strong>
              <span className="spill-viewer-path" title={spillLocator ?? ""}>{spillLocator}</span>
              <button type="button" className="spill-viewer-close" onClick={() => setSpillOpen(false)}>关闭</button>
            </div>
            <div className="spill-viewer-body">
              {spillLoading && <div className="context-history-state">正在读取全文…</div>}
              {spillError && (
                <div className="context-history-state" role="alert">
                  全文文件已丢失或读不到：{spillError}（消息里的预览仍在）
                </div>
              )}
              {spillText !== null && <pre className="spill-viewer-text">{spillText}</pre>}
            </div>
          </div>
        </div>
      )}
    </>
  )
})
