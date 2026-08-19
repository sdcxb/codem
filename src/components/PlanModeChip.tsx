/**
 * PlanModeChip — Composer 内嵌的计划模式切换按钮
 *
 * 对标 DSH ui-plan/src/client/PlanModeControl.tsx 的 PlanChip 组件。
 * 在 Composer 底部栏显示一个 "Plan" 标签，点击切换计划/执行模式。
 * 激活时显示 "Plan" 标记 + 关闭图标，未激活时不显示。
 *
 * 与 PlanApprovalCard 的分工：
 * - PlanModeChip: Composer 内的模式切换 chip（对标 DSH PlanChip）
 * - PlanApprovalCard: exit_plan_mode 工具调用时的审批弹窗（对标 DSH PlanApproval）
 */

import { useState, useCallback } from 'react'
import { X, ClipboardList } from 'lucide-react'
import { useLang } from '../core/i18n/lang'
import type { CollaborationMode } from '../core/agent/agent'

export interface PlanModeChipProps {
  /** 当前协作模式 */
  mode: CollaborationMode
  /** 切换模式回调 */
  onModeChange: (mode: CollaborationMode) => void
  /** 是否锁定（如正在流式输出时） */
  locked?: boolean
}

/**
 * Composer 计划模式 chip。
 * 当 mode === 'plan' 时渲染一个可点击关闭的 Plan 标签。
 * 点击标签关闭计划模式，回到执行模式。
 */
export function PlanModeChip({ mode, onModeChange, locked = false }: PlanModeChipProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [leaving, setLeaving] = useState(false)

  const off = useCallback(() => {
    if (locked || leaving) return
    setLeaving(true)
    try {
      onModeChange('default')
    } finally {
      setLeaving(false)
    }
  }, [locked, leaving, onModeChange])

  if (mode !== 'plan') return null

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        aria-label={zh ? '退出计划模式' : 'Exit plan mode'}
        title={zh ? '计划模式（只读）— 点击退出' : 'Plan mode (read-only) — click to exit'}
        disabled={locked || leaving}
        onClick={off}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 12,
          border: '1px solid var(--accent)',
          background: 'var(--accent-alpha, rgba(99, 102, 241, 0.12))',
          color: 'var(--accent)',
          fontSize: 11,
          fontWeight: 600,
          cursor: locked || leaving ? 'not-allowed' : 'pointer',
          opacity: locked || leaving ? 0.5 : 1,
          transition: 'all 0.15s ease',
        }}
      >
        <ClipboardList size={12} />
        {zh ? '计划' : 'Plan'}
        <span
          style={{ display: 'inline-flex', cursor: 'pointer' }}
          aria-hidden
        >
          <X size={11} />
        </span>
      </button>
    </span>
  )
}
