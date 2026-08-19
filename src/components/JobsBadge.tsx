/**
 * JobsBadge — 会话头部后台任务列表
 *
 * 对标 DSH ui-jobs/src/client/JobListAction.tsx。
 * 在会话头部显示一个带状态点的任务计数器，点击展开下拉列表。
 * 列表中每个任务显示状态、类型、标签、持续时长。
 *
 * 与 TaskCenter 的分工：
 * - JobsBadge: 会话头部轻量级任务指示器（对标 DSH JobListAction）
 * - TaskCenter: 全局任务管理中心面板（已有的重型面板）
 *
 * 数据来源：使用 projectStore 中的 subagentTasks 和 automation 任务列表
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, LoaderCircle, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { useLang } from '../core/i18n/lang'

/** 任务状态 */
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** 任务视图 */
export interface JobView {
  id: string
  kind: string
  label: string
  status: JobStatus
  startedAt: number
  finishedAt?: number
  detail?: string
}

export interface JobsBadgeProps {
  /** 当前会话的任务列表 */
  jobs?: JobView[]
  /** 点击任务回调 */
  onSelectJob?: (jobId: string) => void
}

/** 判断任务是否仍在运行 */
function isLive(job: JobView): boolean {
  return job.status === 'running'
}

/** 获取状态图标 */
function StatusIcon({ status }: { status: JobStatus }) {
  switch (status) {
    case 'running': return <LoaderCircle size={12} className="spin" />
    case 'completed': return <CheckCircle2 size={12} style={{ color: 'var(--success)' }} />
    case 'failed': return <XCircle size={12} style={{ color: 'var(--error)' }} />
    case 'cancelled': return <XCircle size={12} style={{ color: 'var(--warning)' }} />
    default: return null
  }
}

/** 格式化持续时长 */
function formatDuration(elapsedMs: number, zh: boolean): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return zh ? `${hours}时${minutes}分` : `${hours}h ${minutes}m`
  if (minutes > 0) return zh ? `${minutes}分${seconds}秒` : `${minutes}m ${seconds}s`
  return zh ? `${seconds}秒` : `${seconds}s`
}

/**
 * 会话头部任务指示器。
 * 无任务时不渲染。有运行中任务时显示动画状态点。
 */
export function JobsBadge({ jobs = [], onSelectJob }: JobsBadgeProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)

  const liveCount = useMemo(() => jobs.filter(isLive).length, [jobs])

  // 排序：运行中在前，按开始时间排序
  const orderedJobs = useMemo(() => {
    return [...jobs].sort((a, b) => {
      const liveA = isLive(a)
      if (liveA !== isLive(b)) return liveA ? -1 : 1
      if (liveA) return a.startedAt - b.startedAt
      const finished = (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)
      return finished !== 0 ? finished : a.startedAt - b.startedAt
    })
  }, [jobs])

  // 外部点击关闭
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  // 时钟只在有运行中任务且列表打开时运行
  useEffect(() => {
    if (!open || liveCount === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, liveCount])

  // 任务全部消失时关闭
  useEffect(() => {
    if (jobs.length === 0 && open) setOpen(false)
  }, [jobs.length, open])

  if (jobs.length === 0) return null

  const countLabel = liveCount > 0
    ? (liveCount === 1
      ? (zh ? `1 个运行中` : `1 running`)
      : (zh ? `${liveCount} 个运行中` : `${liveCount} running`))
    : (jobs.length === 1
      ? (zh ? `1 个任务` : `1 job`)
      : (zh ? `${jobs.length} 个任务` : `${jobs.length} jobs`))

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          setNow(Date.now())
          setOpen(v => !v)
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 10,
          border: '1px solid var(--border-primary)',
          background: liveCount > 0 ? 'var(--accent-alpha, rgba(99,102,241,0.08))' : 'transparent',
          color: liveCount > 0 ? 'var(--accent)' : 'var(--text-muted)',
          fontSize: 11,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        {liveCount > 0 && (
          <LoaderCircle size={11} className="spin" />
        )}
        <span>{countLabel}</span>
        <ChevronDown size={10} style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 260,
            maxHeight: 320,
            overflowY: 'auto',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            zIndex: 100,
          }}
        >
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {orderedJobs.map(job => {
              const live = isLive(job)
              const elapsed = live
                ? now - job.startedAt
                : (job.finishedAt ?? job.startedAt) - job.startedAt
              const duration = formatDuration(elapsed, zh)
              return (
                <li
                  key={job.id}
                  onClick={() => {
                    onSelectJob?.(job.id)
                    setOpen(false)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderBottom: '1px solid var(--border-primary)',
                    cursor: 'pointer',
                    opacity: live ? 1 : 0.7,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <StatusIcon status={job.status} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 40 }}>
                    {job.kind}
                  </span>
                  <span
                    title={job.label}
                    style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {job.label}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Clock size={9} />
                    {duration}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
