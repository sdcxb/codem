/**
 * ToolCallCard — 工具调用行卡片
 *
 * 对标 DSH ui-tool/src/client/tool/components/ToolRow.tsx + GenericToolCard.tsx
 *
 * 架构：
 * - 变体分类系统 (search/read/bash/write/edit/code/others)
 * - 折叠行：图标 + 标题 + 摘要 + 状态 + 时长
 * - 展开体：IN/OUT gutter-labeled 卡片，或专用卡片（Terminal/Diff/Read/Search/Web）
 * - 专用卡片优先于 IN/OUT 纯文本
 * - 错误行的折叠摘要显示为错误首行
 */

import { memo, useState, useMemo, type ReactNode } from "react";
import {
  Wrench, CheckCircle2, XCircle, LoaderCircle,
  ChevronDown, ChevronRight,
  FileText, Search, Terminal as TerminalIcon, FileEdit, FolderSearch, Bot,
  ExternalLink, Globe, Code2, Sparkles,
} from "lucide-react";

// ====== 类型定义 ======

/** 工具行变体 — 对标 DSH ToolRowVariant */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** 行状态 — 对标 DSH ToolRowState */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

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

// ====== 变体分类 — 对标 DSH classifyTool ======

const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  pwsh: 'bash',
  shell: 'bash',
  read: 'read',
  cat: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  search_notebook: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  todowrite: 'others',
  create_note: 'others',
  edit_note: 'others',
  delete_note: 'others',
  link_notes: 'others',
  load_skill: 'others',
  subagent: 'others',
  spawn_subagent: 'others',
}

const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: 'Search',
  read: 'Read',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  code: 'Code',
  others: 'Tool call',
}

const TOOL_TITLES: Record<string, string> = {
  search_notebook: 'Search Knowledge',
  web_search: 'Web Search',
  web_fetch: 'Web Fetch',
  todowrite: 'Update Tasks',
  load_skill: 'Load Skill',
  spawn_subagent: 'Sub-agent',
  subagent: 'Sub-agent',
  report: 'Agent Report',
  send_message: 'Send Message',
  interrupt_agent: 'Interrupt Agent',
  list_agents: 'List Agents',
  create_note: 'Create Note',
  edit_note: 'Edit Note',
  delete_note: 'Delete Note',
  link_notes: 'Link Notes',
}

function classifyTool(toolName: string): ToolRowVariant {
  const lower = toolName.toLowerCase()
  return TOOL_VARIANTS[lower] ?? 'others'
}

/** 变体前导图标 — 对标 DSH VARIANT_ICONS */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  search: <Search size={14} />,
  read: <FileText size={14} />,
  bash: <TerminalIcon size={14} />,
  write: <FileEdit size={14} />,
  edit: <FileEdit size={14} />,
  code: <Code2 size={14} />,
  others: <Sparkles size={14} />,
}

// ====== 摘要推导 — 对标 DSH deriveSummary ======

const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function deriveSummary(variant: ToolRowVariant, argsRaw: string, fallback?: string): string {
  if (argsRaw === '') return fallback ?? ''
  try {
    const parsed = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
    const args = parsed as Record<string, unknown>
    const picked = pickString(args, SUMMARY_KEYS[variant])
    if (picked !== undefined) return firstLine(picked)
    // 找第一个字符串值
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v !== '') return firstLine(v)
    }
    return firstLine(argsRaw)
  } catch {
    return firstLine(argsRaw)
  }
}

// ====== 文件路径推导 ======

const FILE_PATH_KEYS = ['path', 'file_path'] as const
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit'])

function deriveFilePath(variant: ToolRowVariant, argsRaw: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined
  try {
    const parsed = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return pickString(parsed as Record<string, unknown>, FILE_PATH_KEYS)
  } catch {
    return undefined
  }
}

// ====== IN/OUT 卡片体推导 ======

function deriveBody(variant: ToolRowVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  try {
    const parsed = JSON.parse(argsRaw)
    if (parsed === undefined) return argsRaw
    if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as Record<string, unknown>).code
      if (typeof code === 'string' && code !== '') return code
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return argsRaw
  }
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

function tryTerminalModel(argsRaw: string, result: string | undefined, status: string): TerminalCardModel | null {
  try {
    const parsed = argsRaw ? JSON.parse(argsRaw) : {}
    const cmd = parsed.command || parsed.cmd || ''
    if (!cmd) return null
    const isRunning = status === 'running'
    // 解析退出码
    let exitCode: number | undefined
    let signal: string | undefined
    if (result && !isRunning) {
      const exitMatch = result.match(/(?:exit|code)[:\s]+(\d+)/i)
      if (exitMatch) exitCode = parseInt(exitMatch[1])
      const sigMatch = result.match(/(?:signal|sig)[:\s]+(\w+)/i)
      if (sigMatch) signal = sigMatch[1]
    }
    return {
      command: cmd,
      cwd: parsed.cwd,
      output: result || undefined,
      exitCode,
      signal,
      running: isRunning,
    }
  } catch {
    return null
  }
}

function TerminalBlock({ model }: { model: TerminalCardModel }) {
  return (
    <div className="tool-card terminal-block" style={{
      borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-primary)',
      fontSize: 12,
    }}>
      {/* Prompt 行 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '4px 8px', background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border-primary)',
      }}>
        <TerminalIcon size={11} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          {model.cwd ? model.cwd.split(/[\\/]/).pop() + '$' : '$'}
        </span>
        <code style={{ color: 'var(--text-primary)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model.command}
        </code>
        {model.running ? (
          <span style={{ color: 'var(--accent)', fontSize: 10 }}>
            <LoaderCircle size={10} className="tool-pill-icon-spin" style={{ display: 'inline' }} /> running
          </span>
        ) : model.exitCode !== undefined && model.exitCode !== 0 ? (
          <span style={{ color: 'var(--error)', fontSize: 10 }}>
            exit {model.exitCode}
          </span>
        ) : model.signal ? (
          <span style={{ color: 'var(--error)', fontSize: 10 }}>
            {model.signal}
          </span>
        ) : (
          <span style={{ color: 'var(--success)', fontSize: 10 }}>
            done
          </span>
        )}
      </div>
      {/* Output */}
      {model.output && (
        <pre style={{
          margin: 0, padding: '6px 8px',
          fontSize: 11, fontFamily: 'monospace',
          maxHeight: 200, overflowY: 'auto',
          whiteSpace: 'pre-wrap', color: 'var(--text-secondary)',
        }}>
          {model.output.slice(0, 2000)}
          {model.output.length > 2000 && '\n... (truncated)'}
        </pre>
      )}
    </div>
  )
}

// ====== 专用卡片：Diff ======

interface DiffHunk {
  path: string
  oldText: string | null
  newText: string
}

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

function DiffBlockCard({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="tool-card diff-block" style={{
      borderRadius: 6, overflow: 'hidden',
      border: '1px solid var(--border-primary)',
      maxHeight: 300, overflowY: 'auto',
    }}>
      {hunks.map((hunk, idx) => (
        <div key={idx} style={{ borderBottom: idx < hunks.length - 1 ? '1px solid var(--border-primary)' : 'none' }}>
          <div style={{
            padding: '4px 8px', background: 'var(--bg-tertiary)',
            fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <FileEdit size={11} /> {hunk.path}
          </div>
          <pre style={{
            margin: 0, padding: '4px 8px',
            fontSize: 11, fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
          }}>
            {hunk.newText.split('\n').map((line, i) => (
              <div key={i} style={{
                color: line.startsWith('+') && !line.startsWith('+++')
                  ? 'var(--success)'
                  : line.startsWith('-') && !line.startsWith('---')
                  ? 'var(--error)'
                  : 'var(--text-secondary)',
                background: line.startsWith('+') && !line.startsWith('+++')
                  ? 'rgba(34, 197, 94, 0.08)'
                  : line.startsWith('-') && !line.startsWith('---')
                  ? 'rgba(239, 68, 68, 0.08)'
                  : 'transparent',
              }}>
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  )
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
    <div className="tool-card read-block" style={{
      borderRadius: 6, overflow: 'hidden',
      border: '1px solid var(--border-primary)',
      maxHeight: 300, overflowY: 'auto',
    }}>
      <div style={{
        padding: '4px 8px', background: 'var(--bg-tertiary)',
        fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <FileText size={11} /> {path}
      </div>
      <pre style={{ margin: 0, padding: '4px 8px', fontSize: 11, fontFamily: 'monospace' }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 24, textAlign: 'right', userSelect: 'none', opacity: 0.6 }}>
              {i + 1}
            </span>
            <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
              {line || ' '}
            </span>
          </div>
        ))}
        {content.split('\n').length > 50 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 10, padding: '4px 0' }}>
            ... ({content.split('\n').length - 50} more lines)
          </div>
        )}
      </pre>
    </div>
  )
}

// ====== 专用卡片：Search (grep/glob 结果分组) ======

function trySearchModel(toolName: string, result: string | undefined): { kind: 'matches' | 'paths'; files?: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>; paths?: string[] } | null {
  if (!result) return null
  const lower = toolName.toLowerCase()
  if (lower !== 'grep' && lower !== 'glob' && lower !== 'search' && !lower.includes('search')) return null

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
    <div className="tool-card search-block" style={{
      borderRadius: 6, overflow: 'hidden',
      border: '1px solid var(--border-primary)',
      maxHeight: 300, overflowY: 'auto',
    }}>
          {model.kind === 'matches' && model.files?.map((file, fi) => (
            <div key={fi} style={{ borderBottom: fi < (model.files?.length ?? 0) - 1 ? '1px solid var(--border-primary)' : 'none' }}>
          <div style={{
            padding: '3px 8px', background: 'var(--bg-tertiary)',
            fontSize: 11, fontWeight: 600, color: 'var(--accent)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <FolderSearch size={11} /> {file.path}
            <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>
              · {file.matches.length} match{file.matches.length > 1 ? 'es' : ''}
            </span>
          </div>
          {file.matches.slice(0, 8).map((m: any, mi: number) => (
            <div key={mi} style={{
              display: 'flex', gap: 8, padding: '2px 8px',
              fontSize: 11, fontFamily: 'monospace',
            }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 28, textAlign: 'right', opacity: 0.6 }}>
                {m.lineNumber}
              </span>
              <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.line}
              </span>
            </div>
          ))}
          {file.matches.length > 8 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 8px' }}>
              ... {file.matches.length - 8} more
            </div>
          )}
        </div>
      ))}
      {model.kind === 'paths' && model.paths && (
        <div style={{ padding: '4px 8px', fontSize: 11, fontFamily: 'monospace' }}>
          {model.paths.map((p, pi) => (
            <div key={pi} style={{ color: 'var(--text-secondary)', padding: '1px 0' }}>
              {p}
            </div>
          ))}
          {model.paths.length === 100 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 10, padding: '4px 0' }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Globe size={12} style={{ color: 'var(--accent)' }} />
        <span className="tool-pill-detail-label" style={{ margin: 0 }}>
          {query ? `Search: "${query}"` : 'Web Search'}
        </span>
        {source && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {source}</span>}
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {searchResults.length} results</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {searchResults.map((result, idx) => (
          <div key={idx} style={{
            padding: '6px 8px', borderRadius: 6,
            background: 'var(--bg-tertiary)',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 16 }}>{idx + 1}.</span>
              {result.url ? (
                <a href={result.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{
                  fontSize: 12, fontWeight: 500, color: 'var(--accent)', textDecoration: 'none',
                  display: 'flex', alignItems: 'center', gap: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {result.title || result.url}
                  <ExternalLink size={10} style={{ flexShrink: 0 }} />
                </a>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {result.title}
                </span>
              )}
            </div>
            {result.snippet && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
  const [expanded, setExpanded] = useState(false)

  const variant = useMemo(() => classifyTool(toolName), [toolName])
  const title = TOOL_TITLES[toolName.toLowerCase()] ?? VARIANT_TITLES[variant]
  const Icon = VARIANT_ICONS[variant]

  const isRunning = status === 'running'
  const isError = status === 'error'
  const rowState: ToolRowState = isRunning ? 'running' : isError ? 'error' : 'ok'

  // 摘要：优先用 argsSummary，否则从 args 推导
  const summary = useMemo(() => {
    if (argsSummary) return argsSummary
    return deriveSummary(variant, toolArgs || '', toolName)
  }, [variant, toolArgs, argsSummary, toolName])

  // 文件路径
  const filePath = useMemo(() => deriveFilePath(variant, toolArgs || ''), [variant, toolArgs])

  // IN/OUT body
  const body = useMemo(() => {
    if (filePath) return null // 单文件工具不展示 args body
    return deriveBody(variant, toolArgs || '')
  }, [variant, toolArgs, filePath])

  const output = toolResult || null
  const errorSummary = isError && output ? firstLine(output) : null

  // 专用卡片推导
  const terminalModel = useMemo(() => {
    if (variant !== 'bash') return null
    return tryTerminalModel(toolArgs || '', toolResult, status)
  }, [variant, toolArgs, toolResult, status])

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

  // 有任何卡片材料？
  const hasCard = terminalModel !== null || diffHunks !== null || readModel !== null || searchModel !== null || isWebSearch
  const hasDetail = body !== null || output !== null || hasCard
  const expandable = hasDetail
  const open = expanded && expandable

  // 折叠行摘要：错误行用错误首行
  const collapsedSummary = errorSummary ?? summary

  // 前导图标：运行/错误时替换为状态指示
  function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
    switch (state) {
      case 'error': return <XCircle size={10} className="tool-pill-icon-error" />
      case 'stopped': return <XCircle size={10} style={{ color: 'var(--warning, #eab008)' }} />
      default: return icon
    }
  }

  return (
    <div className="tool-call-card-wrap" data-variant={variant} data-state={rowState} data-tool={toolName}>
      {/* 折叠行 */}
      <div
        className={`tool-call-pill ${isError ? 'error' : ''} ${expandable ? 'expandable' : ''}`}
        onClick={expandable ? () => setExpanded(e => !e) : undefined}
        role={expandable ? 'button' : undefined}
      >
        {/* 前导图标 + 状态 */}
        <div className="tool-pill-icon-frame">
          {isRunning ? (
            <LoaderCircle size={10} className="tool-pill-icon-spin" />
          ) : (
            leadingFor(rowState, <span className="tool-pill-icon">{Icon}</span>)
          )}
        </div>

        {/* 标题 */}
        <span className="tool-pill-text">
          <span style={{ fontWeight: 600 }}>{title}</span>
          {/* 摘要 */}
          {collapsedSummary && collapsedSummary !== title && (
            <span className="tool-pill-preview"> · {collapsedSummary}</span>
          )}
          {/* 文件路径链接 */}
          {filePath && (
            <span className="tool-pill-preview" style={{ color: 'var(--accent)', fontFamily: 'monospace', fontSize: 11 }}>
              {filePath}
            </span>
          )}
        </span>

        {/* 时长 */}
        {duration !== undefined && duration > 0 && (
          <span className="tool-pill-duration">{(duration / 1000).toFixed(1)}s</span>
        )}

        {/* 展开/折叠指示器 */}
        {expandable && (
          expanded ? <ChevronDown size={12} className="tool-pill-chevron" />
                   : <ChevronRight size={12} className="tool-pill-chevron" />
        )}
      </div>

      {/* 展开体 — 对标 DSH ToolRow bodyWrap */}
      {open && (
        <div className="tool-pill-detail" style={{ marginLeft: 16 }}>
          {/* 专用卡片优先 */}
          {terminalModel !== null ? (
            <TerminalBlock model={terminalModel} />
          ) : diffHunks !== null ? (
            <DiffBlockCard hunks={diffHunks} />
          ) : readModel !== null ? (
            <ReadBlockCard path={readModel.path} content={readModel.content} />
          ) : searchModel !== null ? (
            <SearchBlockCard model={searchModel} />
          ) : isWebSearch && toolResult ? (
            <WebSearchResultCard output={toolResult} />
          ) : (
            /* 通用 IN/OUT 卡片 */
            (body !== null || output !== null) && (
              <div className="tool-io-card" style={{
                borderRadius: 6, overflow: 'hidden',
                border: '1px solid var(--border-primary)',
              }}>
                {body !== null && (
                  <div className="tool-io-section" style={{
                    display: 'flex', gap: 8,
                    borderBottom: output !== null ? '1px solid var(--border-primary)' : 'none',
                  }}>
                    <span className="tool-io-label" style={{
                      padding: '4px 8px', background: 'var(--bg-tertiary)',
                      fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                      minWidth: 28, textAlign: 'center', flexShrink: 0,
                    }}>IN</span>
                    <pre className="tool-io-text" style={{
                      margin: 0, padding: '4px 8px',
                      fontSize: 11, fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap', color: 'var(--text-secondary)',
                      maxHeight: 200, overflowY: 'auto',
                    }}>{body}</pre>
                  </div>
                )}
                {output !== null && (
                  <div className="tool-io-section" style={{ display: 'flex', gap: 8 }}>
                    <span className="tool-io-label" style={{
                      padding: '4px 8px', background: 'var(--bg-tertiary)',
                      fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                      minWidth: 28, textAlign: 'center', flexShrink: 0,
                    }}>OUT</span>
                    <pre className="tool-io-text" style={{
                      margin: 0, padding: '4px 8px',
                      fontSize: 11, fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                      color: isError ? 'var(--error)' : 'var(--text-secondary)',
                      maxHeight: 200, overflowY: 'auto',
                    }} data-error={isError || undefined}>{output}</pre>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
})
