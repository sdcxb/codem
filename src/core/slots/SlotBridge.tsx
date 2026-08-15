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

/**
 * 泛型 SlotBridge：从 fallback 组件的 Props 类型自动推断 props 类型。
 *
 * 使用泛型参数 P 捕获 fallback 组件的 props 类型，
 * 这样调用方的回调参数能获得精确的类型推断，
 * 而不是全部退化为 any。
 */
export function SlotBridge<P extends Record<string, any>>(
  props: { name: string } & { fallback?: ComponentType<P> } & P
): ReactNode {
  const { name, fallback: Fallback, ...rest } = props
  const ctx = tryGetCtx()

  // 如果 Cordis Context 未初始化或 Slot 服务不可用，使用 fallback
  if (!ctx?.slots) {
    return Fallback ? <Fallback {...(rest as unknown as P)} /> : null
  }

  const entries = useSlotEntries(ctx, name)

  if (entries.length === 0) {
    // 没有注册的组件，使用 fallback
    return Fallback ? <Fallback {...(rest as unknown as P)} /> : null
  }

  // 取最高优先级的注册组件
  const entry = entries[entries.length - 1]
  const Component = entry.component as ComponentType<P>

  if (!Component) {
    return Fallback ? <Fallback {...(rest as unknown as P)} /> : null
  }

  return (
    <Suspense fallback={<div className="slot-loading">Loading...</div>}>
      <Component {...(rest as unknown as P)} />
    </Suspense>
  )
}

/**
 * 渲染 list 类型 slot 中的所有组件。
 * 用于 overlay 类型的 slot（如 app.overlay）。
 */
export function SlotListBridge<P extends Record<string, any>>(
  props: { name: string } & P
): ReactNode {
  const { name, ...rest } = props
  const ctx = tryGetCtx()

  if (!ctx?.slots) {
    return null
  }

  const entries = useSlotEntries(ctx, name)

  if (entries.length === 0) {
    return null
  }

  return entries.map((entry, i) => {
    const Component = entry.component as ComponentType<P>
    if (!Component) return null
    return (
      <Suspense key={entry.options.id || i} fallback={null}>
        <Component {...(rest as unknown as P)} />
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
