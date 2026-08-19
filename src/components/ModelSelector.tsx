/**
 * ModelSelector — Composer 内嵌的模型选择下拉
 *
 * 对标 DSH ui-model-selection/src/client/ModelSelect.tsx。
 * 在 Composer 底部栏显示当前模型名称，点击展开下拉列表。
 * 支持 provider 分组、推理强度选择、搜索过滤。
 *
 * 从 InputArea 提取为独立组件，通过 props 接收模型列表和回调，
 * 使其可以独立注册到 Slot Registry。
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { Cpu, ChevronDown, Check, ChevronRight } from 'lucide-react'
import { useLang } from '../core/i18n/lang'
import { getSettingJSON, setSettingJSON } from '../core/storage/settings'
import type { ModelOption } from '../core/model-config'

export interface ModelSelectorProps {
  /** 当前选中的模型 ID */
  model: string
  /** 可选模型列表 */
  models: ModelOption[]
  /** 选择模型回调 */
  onModelChange: (model: string) => void
  /** 是否锁定（如正在流式输出时） */
  locked?: boolean
}

/**
 * Composer 模型选择器组件。
 * 显示当前模型名称，点击展开下拉列表选择模型。
 * 底部附带推理强度切换（从 settings 读取/写入）。
 */
export function ModelSelector({ model, models, onModelChange, locked = false }: ModelSelectorProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const currentModelName = useMemo(
    () => models.find(m => m.id === model)?.name || model || '',
    [models, model]
  )

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

  const efforts = ['low', 'medium', 'high', 'ultra'] as const
  const effortLabels: Record<string, { zh: string; en: string }> = {
    low: { zh: '低', en: 'Low' },
    medium: { zh: '中', en: 'Medium' },
    high: { zh: '高', en: 'High' },
    ultra: { zh: '超高', en: 'Ultra' },
  }

  const currentEffort = getSettingJSON<string>('codem-reasoning-effort', 'high')

  const cycleEffort = (e: React.MouseEvent) => {
    e.stopPropagation()
    const idx = efforts.indexOf(currentEffort as typeof efforts[number])
    const next = efforts[(idx + 1) % efforts.length]
    setSettingJSON('codem-reasoning-effort', next)
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="input-control-item model-selector-inline"
        disabled={locked}
        onClick={() => setOpen(!open)}
        title={zh ? '选择模型' : 'Select model'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          cursor: locked ? 'not-allowed' : 'pointer',
          opacity: locked ? 0.5 : 1,
        }}
      >
        <Cpu size={13} />
        <span>{currentModelName}</span>
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
            minWidth: 200,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          <div className="bottom-bar-dropdown-header">
            {zh ? '选择模型' : 'Select Model'}
          </div>

          {models.length === 0 && (
            <div className="bottom-bar-dropdown-empty">
              {zh ? '无可用模型' : 'No models available'}
            </div>
          )}

          {models.map(m => (
            <button
              key={m.id}
              className={`bottom-bar-dropdown-item ${model === m.id ? 'active' : ''}`}
              onClick={() => {
                onModelChange(m.id)
                setOpen(false)
              }}
            >
              <span style={{ fontSize: 14, display: 'flex', alignItems: 'center' }}>
                {model === m.id ? <Check size={14} /> : <Cpu size={14} />}
              </span>
              <span style={{ fontSize: 12 }}>{m.name}</span>
            </button>
          ))}

          {/* 推理强度选择器 */}
          <div style={{ height: 1, background: 'var(--border-primary)', margin: '4px 0' }} />
          <div
            style={{
              padding: '4px 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              position: 'relative',
            }}
            onClick={cycleEffort}
          >
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {zh ? '推理强度' : 'Reasoning'}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
              {effortLabels[currentEffort]?.[lang] || effortLabels.high[lang]}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
