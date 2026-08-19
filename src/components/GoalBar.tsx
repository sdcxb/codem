/**
 * GoalBar — 目标指示条
 *
 * 对标 DSH ui-goal/src/client/GoalBar.tsx。
 * 在 Composer 输入区上方显示当前目标（如果设置了的话）。
 * 显示目标图标、阶段标签、目标文本，以及暂停/恢复/编辑/清除操作。
 *
 * 与 PlanApprovalCard 的分工：
 * - GoalBar: Composer 上方的目标指示条（对标 DSH GoalBar）
 * - PlanApprovalCard: exit_plan_mode 工具调用时的审批弹窗
 */

import { useState, useCallback } from 'react'
import { Target, Pause, Play, Edit2, Trash2, X, Check } from 'lucide-react'
import { useLang } from '../core/i18n/lang'

export interface GoalSnapshot {
  id: string
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { message: string }
}

export interface GoalBarProps {
  /** 当前目标快照；undefined = 加载中，null = 无目标 */
  goal?: GoalSnapshot | null
  /** 编辑目标回调 */
  onEdit?: (objective: string) => void
  /** 暂停目标回调 */
  onPause?: () => void
  /** 恢复目标回调 */
  onResume?: () => void
  /** 清除目标回调 */
  onClear?: () => void
}

const PHASE_LABELS_ZH: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成',
}

const PHASE_LABELS_EN: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  complete: 'Complete',
}

/**
 * 目标指示条组件。
 * 无目标或已完成时不渲染。
 */
export function GoalBar({ goal, onEdit, onPause, onResume, onClear }: GoalBarProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  // 无目标或已完成 → 不渲染
  if (goal === undefined || goal === null || goal.phase === 'complete') return null

  const handleEdit = useCallback(async () => {
    const trimmed = draft.trim()
    if (trimmed === '') return
    setPending(true)
    try {
      onEdit?.(trimmed)
      setEditing(false)
    } finally {
      setPending(false)
    }
  }, [draft, onEdit])

  const runAction = useCallback(async (action: () => void) => {
    setPending(true)
    try {
      action()
    } finally {
      setPending(false)
    }
  }, [])

  if (editing) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-primary)',
      }}>
        <Target size={14} style={{ color: 'var(--accent)' }} />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleEdit()
            if (e.key === 'Escape') setEditing(false)
          }}
          autoFocus
          style={{
            flex: 1,
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        />
        <button
          onClick={handleEdit}
          disabled={pending || draft.trim() === ''}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--success)' }}
        >
          <Check size={14} />
        </button>
        <button
          onClick={() => setEditing(false)}
          disabled={pending}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  const phaseLabel = zh ? PHASE_LABELS_ZH[goal.phase] : PHASE_LABELS_EN[goal.phase]
  const title = goal.phase === 'blocked' ? goal.blockedReason?.message : undefined

  return (
    <div
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-primary)',
        fontSize: 12,
      }}
    >
      <Target size={14} style={{ color: 'var(--accent)' }} />
      <span style={{ fontWeight: 600, color: 'var(--accent)', fontSize: 11 }}>{phaseLabel}</span>
      <span style={{
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--text-primary)',
      }}>
        {goal.objective}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {goal.phase === 'active' && (
          <button
            onClick={() => runAction(() => onPause?.())}
            disabled={pending}
            title={zh ? '暂停' : 'Pause'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
          >
            <Pause size={12} />
          </button>
        )}
        {goal.phase === 'paused' && (
          <button
            onClick={() => runAction(() => onResume?.())}
            disabled={pending}
            title={zh ? '恢复' : 'Resume'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
          >
            <Play size={12} />
          </button>
        )}
        <button
          onClick={() => { setDraft(goal.objective); setEditing(true) }}
          disabled={pending}
          title={zh ? '编辑' : 'Edit'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
        >
          <Edit2 size={12} />
        </button>
        <button
          onClick={() => runAction(() => onClear?.())}
          disabled={pending}
          title={zh ? '清除' : 'Clear'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}
