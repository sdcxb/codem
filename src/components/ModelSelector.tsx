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
import { getModelsForMode } from '../core/model-config'
import type { ModelOption } from '../core/model-config'
import { useAppStore } from '../store'

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
 *
 * ## 第 45 轮 D-15：注册到 Slot 时**必须能空 props 渲染**
 *
 * 审计事实：这个组件被 `ui-model-selection-provider.ts:92/96` 与
 * `ui-plugins/ui-panels/index.ts:128` 注册进 slot，而 `SlotBridge`/`SlotListBridge`
 * **不传 props**（`SlotBridge.tsx:254` 只转发调用点给的 props）——
 * 于是 `models` 是 `undefined`，`models.find(...)` 直接抛错并被 `SlotErrorBoundary` 吞掉
 * （表现为"这个 slot 一片空白、控制台一行错误"）。
 *
 * 现在 props 全部可缺省：缺省时模型列表按 `codem-settings.mode` 推导
 * （`getModelsForMode`，与 ChatPanel/InputArea 同一来源）、当前模型取 `useAppStore.currentModel`；
 * 没有 `onModelChange` 时列表项不可点（不假装能切换）。
 */
export function ModelSelector({ model: modelProp, models: modelsProp, onModelChange, locked = false }: Partial<ModelSelectorProps>) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 空 props 时的活性来源（同一份 store/设置，不是新造第二份状态）
  const storeModel = useAppStore((s) => s.currentModel)
  const mode: 'cli' | 'api' =
    getSettingJSON<{ mode?: string }>('codem-settings', {}).mode === 'api' ? 'api' : 'cli'
  const model = modelProp ?? storeModel ?? ''
  const canPick = typeof onModelChange === 'function'
  const models = useMemo<ModelOption[]>(() => {
    if (Array.isArray(modelsProp)) return modelsProp
    return getModelsForMode(mode)
  }, [modelsProp, mode])

  const currentModelName = useMemo(
    // 第 45 轮 D-15：`models` 可能为空数组/undefined（旧版本直接 `models.find` 抛错）
    () => models?.find?.(m => m.id === model)?.name || model || '',
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

  /**
   * 推理强度必须**进 state**（第 82 波修）。
   *
   * 之前是渲染时现读 `getSettingJSON('codem-reasoning-effort')`，而 `cycleEffort` 只写存储、
   * 不触发重渲染 —— 于是点一下"值变了但界面不动"，要点好几次、或者等别的状态变化把界面刷出来
   * 才看到结果，用户感受就是"点了没反应"。
   */
  const [currentEffort, setCurrentEffort] = useState<string>(() =>
    getSettingJSON<string>('codem-reasoning-effort', 'high'),
  )

  const cycleEffort = (e: React.MouseEvent) => {
    e.stopPropagation()
    const idx = efforts.indexOf(currentEffort as typeof efforts[number])
    const next = efforts[(idx + 1) % efforts.length]
    setSettingJSON('codem-reasoning-effort', next)
    setCurrentEffort(next) // 立即回显（写入是持久化，setState 才是界面）
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
        <Cpu size={14} />
        <span>{currentModelName}</span>
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>

      {open && (
        <div
          className="bottom-bar-dropdown popover-shell"
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
            <div className="empty-hint is-compact">
              {zh ? '无可用模型' : 'No models available'}
            </div>
          )}

          {models.map(m => (
            <button
              key={m.id}
              className={`bottom-bar-dropdown-item ${model === m.id ? 'active' : ''}`}
              // D-15：没有 onModelChange 时不可点 —— 不假装能切换（点击后什么都不会发生最伤人）
              disabled={!canPick}
              onClick={() => {
                if (!canPick) return
                onModelChange(m.id)
                setOpen(false)
              }}
            >
              <span style={{ fontSize: 'var(--fs-md)', display: 'flex', alignItems: 'center' }}>
                {model === m.id ? <Check size={14} /> : <Cpu size={14} />}
              </span>
              <span style={{ fontSize: 'var(--fs-sm)' }}>{m.name}</span>
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
            <span className="hint-sm">
              {zh ? '推理强度' : 'Reasoning'}
            </span>
            <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--accent)' }}>
              {effortLabels[currentEffort]?.[lang] || effortLabels.high[lang]}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
