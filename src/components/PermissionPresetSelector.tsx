/**
 * PermissionPresetSelector — 权限预设快速选择器
 *
 * 对标 DSH ui-permission-presets/src/client/PermissionRow.tsx。
 * 在 Composer 底部栏或 Settings 面板显示当前安全模式，
 * 点击展开下拉列表快速切换 ask/auto/full。
 *
 * 从 SettingsPanel 的 SecurityModeSelector 提取为独立组件，
 * 使其可以独立注册到 Slot Registry。
 * 保留与 SecurityModeSelector 相同的 API 以兼容现有调用。
 */

import { useState, useRef, useEffect } from 'react'
import { Shield, Zap, Rocket, ChevronDown, Check } from 'lucide-react'
import { useLang } from '../core/i18n/lang'
import {
  SECURITY_MODES,
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  getEffectiveSecurityMode,
  setProjectSecurityMode,
  type SecurityMode,
  type SecurityModeInfo,
} from '../core/permission/security-mode'

// 图标映射
const MODE_ICONS: Record<string, typeof Shield> = {
  '🛡️': Shield,
  '⚡': Zap,
  '🚀': Rocket,
}

export interface PermissionPresetSelectorProps {
  /** 项目路径（可选，用于 per-project 模式） */
  projectPath?: string
  /** 当前模式（如不提供则从全局设置读取） */
  currentMode?: SecurityMode
  /** 模式变更回调 */
  onModeChange?: (mode: SecurityMode) => void
  /** 是否使用紧凑布局 */
  compact?: boolean
  /** 是否锁定 */
  locked?: boolean
}

/**
 * 权限预设选择器组件。
 * 可以在 Composer 底部栏或 Settings 面板中使用。
 * 支持全局和 per-project 两种模式。
 */
export function PermissionPresetSelector({
  projectPath,
  currentMode: providedMode,
  onModeChange,
  compact = false,
  locked = false,
}: PermissionPresetSelectorProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const effectiveMode = providedMode ?? (projectPath ? getEffectiveSecurityMode(projectPath) : getGlobalSecurityMode())

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

  const handleSelect = (mode: SecurityMode) => {
    if (projectPath) {
      setProjectSecurityMode(projectPath, mode)
    } else {
      setGlobalSecurityMode(mode)
    }
    onModeChange?.(mode)
    setOpen(false)
    window.dispatchEvent(new Event('codem-settings-changed'))
  }

  const currentInfo = SECURITY_MODES.find(m => m.mode === effectiveMode)

  // 紧凑模式 — 用于 Composer 底部栏
  if (compact) {
    return (
      <div ref={rootRef} style={{ position: 'relative' }}>
        <button
          type="button"
          className="input-control-item security-mode-btn"
          disabled={locked}
          onClick={() => setOpen(!open)}
          title={currentInfo ? (zh ? currentInfo.desc_zh : currentInfo.desc_en) : ''}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: locked ? 'not-allowed' : 'pointer',
            opacity: locked ? 0.5 : 1,
          }}
        >
          {(() => {
            const Icon = MODE_ICONS[currentInfo?.icon || '🛡️'] || Shield
            return <Icon size={13} />
          })()}
          <span style={{ fontSize: 12 }}>
            {currentInfo ? (zh ? currentInfo.label_zh : currentInfo.label_en) : effectiveMode}
          </span>
          <ChevronDown size={10} style={{ opacity: 0.5 }} />
        </button>

        {open && (
          <div
            className="bottom-bar-dropdown"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              minWidth: 180,
            }}
          >
            <div className="bottom-bar-dropdown-header">
              {zh ? '安全策略' : 'Security Policy'}
            </div>
            {SECURITY_MODES.map(m => {
              const Icon = MODE_ICONS[m.icon] || Shield
              return (
                <button
                  key={m.mode}
                  className={`bottom-bar-dropdown-item ${effectiveMode === m.mode ? 'active' : ''}`}
                  onClick={() => handleSelect(m.mode)}
                  title={zh ? m.desc_zh : m.desc_en}
                >
                  <Icon size={14} />
                  <span style={{ fontSize: 12 }}>{zh ? m.label_zh : m.label_en}</span>
                  {effectiveMode === m.mode && <Check size={12} style={{ marginLeft: 'auto' }} />}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // 完整模式 — 用于 Settings 面板
  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={locked}
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 6,
          border: `1px solid var(--border-primary)`,
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          cursor: locked ? 'not-allowed' : 'pointer',
          fontSize: 13,
          minWidth: 200,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {(() => {
            const Icon = MODE_ICONS[currentInfo?.icon || '🛡️'] || Shield
            return <Icon size={15} />
          })()}
          {currentInfo ? (zh ? currentInfo.label_zh : currentInfo.label_en) : effectiveMode}
        </span>
        <ChevronDown size={12} style={{ opacity: 0.5 }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 240,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            zIndex: 100,
            overflow: 'hidden',
          }}
        >
          {SECURITY_MODES.map(m => {
            const Icon = MODE_ICONS[m.icon] || Shield
            return (
              <button
                key={m.mode}
                onClick={() => handleSelect(m.mode)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: '8px 12px',
                  width: '100%',
                  background: effectiveMode === m.mode ? 'var(--accent-alpha, rgba(99,102,241,0.08))' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border-primary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                  <Icon size={15} />
                  {zh ? m.label_zh : m.label_en}
                  {effectiveMode === m.mode && <Check size={12} style={{ marginLeft: 'auto' }} />}
                </span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>
                  {zh ? m.desc_zh : m.desc_en}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
