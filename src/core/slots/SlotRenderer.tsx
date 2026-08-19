// @ts-nocheck
/**
 * SlotRenderer — React 组件，从 Cordis Slot Registry 获取注册的组件并渲染。
 *
 * 这是连接 Cordis Slot Registry 和 React 渲染的桥梁。
 *
 * 使用方式：
 * ```tsx
 * <SlotRenderer name="app.sidebar" props={{ onSettings: () => {} }} />
 * <SlotRenderer name="app.conversation" fallback={<div>Loading...</div>} />
 * <SlotRenderer name="app.settings" entryKey="general" />
 * ```
 */
import { useSyncExternalStore, lazy, Suspense, type ReactNode, type ComponentType } from 'react'
import { tryGetCtx } from '../consumer/index.ts'
import type { StoredEntry } from '../slots/index.ts'

/** 从 Slot Registry 获取组件并渲染 */
export function SlotRenderer({
  name,
  entryKey,
  props,
  fallback = null,
  filter,
}: {
  name: string
  entryKey?: string
  props?: Record<string, any>
  fallback?: ReactNode
  filter?: (entry: StoredEntry) => boolean
}): ReactNode {
  const ctx = tryGetCtx()
  const slots = ctx?.get('slots')
  if (!slots) {
    return fallback
  }

  const entries = useSlotEntries(slots, name, entryKey, filter)
  if (entries.length === 0) {
    return fallback
  }

  // 取最后一个（最高优先级）注册的组件
  const entry = entries[entries.length - 1]
  const Component = entry.component as ComponentType<any>

  if (!Component) {
    return fallback
  }

  return (
    <Suspense fallback={fallback || <div className="slot-loading">Loading...</div>}>
      <Component {...props} />
    </Suspense>
  )
}

/** 渲染所有注册到 list 类型 slot 的组件 */
export function SlotListRenderer({
  name,
  props,
  fallback = null,
  filter,
}: {
  name: string
  props?: Record<string, any>
  fallback?: ReactNode
  filter?: (entry: StoredEntry) => boolean
}): ReactNode {
  const ctx = tryGetCtx()
  const slots = ctx?.get('slots')
  if (!slots) {
    return fallback
  }

  const entries = useSlotEntries(slots, name, undefined, filter)
  if (entries.length === 0) {
    return fallback
  }

  return entries.map((entry, i) => {
    const Component = entry.component as ComponentType<any>
    if (!Component) return null
    return (
      <Suspense key={entry.options.id || i} fallback={<div className="slot-loading">Loading...</div>}>
        <Component {...props} {...(entry.inject?.() || {})} />
      </Suspense>
    )
  })
}

/**
 * Hook: 订阅 Slot 的 entries 变化，使用 useSyncExternalStore 保证一致性。
 */
function useSlotEntries(
  slots: any,
  key: string,
  entryKey?: string,
  filter?: (entry: StoredEntry) => boolean,
): StoredEntry[] {
  return useSyncExternalStore(
    (onChange) => slots.subscribe(key, onChange),
    () => {
      let entries = slots.entriesOfSlot(key) as StoredEntry[]
      if (entryKey) {
        entries = entries.filter(e => e.options.key === entryKey)
      }
      if (filter) {
        entries = entries.filter(filter)
      }
      return entries
    },
    () => [] as StoredEntry[],
  )
}
