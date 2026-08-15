// @ts-nocheck
/**
 * SlotBridge — 连接 App.tsx 和 Cordis Slot Registry 的桥梁组件。
 *
 * 工作原理：
 * 1. 从 Slot Registry 获取注册的组件（如果存在）
 * 2. 如果存在，渲染该组件并传递所有 props
 * 3. 如果不存在，渲染 fallback 组件并传递所有 props
 *
 * 这样实现了"组件来源可替换"：插件可以注册更高优先级的组件来替换默认实现，
 * 同时保持了 props 的完整传递，不影响现有功能。
 *
 * 使用方式：
 * ```tsx
 * <SlotBridge name="app.sidebar" fallback={Sidebar} {...sidebarProps} />
 * <SlotBridge name="app.conversation" fallback={ChatPanel} {...chatProps} />
 * ```
 */
import { useSyncExternalStore, Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { tryGetCtx } from '../consumer/index.ts'
import type { StoredEntry } from '../slots/index.ts'

interface SlotBridgeProps {
  /** Slot 名称 */
  name: string
  /** 回退组件（如果 Slot 中没有注册的组件） */
  fallback?: ComponentType<any>
  /** 传递给组件的 props */
  [key: string]: any
}

export function SlotBridge({ name, fallback: Fallback, ...props }: SlotBridgeProps): ReactNode {
  const ctx = tryGetCtx()

  // 如果 Cordis Context 未初始化或 Slot 服务不可用，使用 fallback
  if (!ctx?.slots) {
    return Fallback ? <Fallback {...props} /> : null
  }

  const entries = useSlotEntries(ctx, name)

  if (entries.length === 0) {
    // 没有注册的组件，使用 fallback
    return Fallback ? <Fallback {...props} /> : null
  }

  // 取最高优先级的注册组件
  const entry = entries[entries.length - 1]
  const Component = entry.component as ComponentType<any>

  if (!Component) {
    return Fallback ? <Fallback {...props} /> : null
  }

  return (
    <Suspense fallback={<div className="slot-loading">Loading...</div>}>
      <Component {...props} />
    </Suspense>
  )
}

/**
 * 渲染 list 类型 slot 中的所有组件。
 * 用于 overlay 类型的 slot（如 app.overlay）。
 */
export function SlotListBridge({ name, ...props }: { name: string } & Record<string, any>): ReactNode {
  const ctx = tryGetCtx()

  if (!ctx?.slots) {
    return null
  }

  const entries = useSlotEntries(ctx, name)

  if (entries.length === 0) {
    return null
  }

  return entries.map((entry, i) => {
    const Component = entry.component as ComponentType<any>
    if (!Component) return null
    return (
      <Suspense key={entry.options.id || i} fallback={null}>
        <Component {...props} />
      </Suspense>
    )
  })
}

/**
 * Hook: 订阅 Slot 的 entries 变化。
 */
function useSlotEntries(ctx: any, key: string): StoredEntry[] {
  return useSyncExternalStore(
    (onChange) => ctx.slots.subscribe(key, onChange),
    () => {
      const entries = ctx.slots.entriesOfSlot(key) as StoredEntry[]
      return entries
    },
    () => [] as StoredEntry[],
  )
}
