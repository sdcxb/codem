// @ts-nocheck
/**
 * SlotRenderer — React 组件，从 Cordis Slot Registry 获取注册的组件并渲染。
 *
 * 对标 DSH scoped-slots.tsx 的 SlotOutlet：
 * - useSyncExternalStore 仅用于版本通知
 * - subscribe/getVersion 闭包用 WeakMap 缓存，永不在渲染中重建
 * - entries 在渲染体中读取，不在 getSnapshot 中
 * - 不使用 Suspense — DSH 完全不用 lazy，组件同步导入
 */
import { useSyncExternalStore, type ReactNode, type ComponentType, Component } from 'react'
import { tryGetCtx, useCtxReady } from '../consumer/index.ts'
import type { StoredEntry } from '../slots/index.ts'

/**
 * 插件组件错误边界 — 对标 DSH scoped-slots.tsx SlotErrorBoundary。
 */
class SlotRendererErrorBoundary extends Component<
  { children: ReactNode; slotName: string; fallback?: ReactNode; entryKey?: string | number },
  { hasError: boolean; error?: Error }
> {
  state: { hasError: boolean; error?: Error } = { hasError: false }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error(`[SlotRenderer] Plugin component crashed for slot "${this.props.slotName}":`, error)
  }

  componentDidUpdate(prevProps: Readonly<{ children: ReactNode; slotName: string; fallback?: ReactNode; entryKey?: string | number }>) {
    if (this.state.hasError && prevProps.entryKey !== this.props.entryKey) {
      this.setState({ hasError: false, error: undefined })
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div data-slot-error={this.props.slotName} style={{ padding: '8px 12px', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          ⚠️ 插件组件崩溃（slot: {this.props.slotName}）
          {this.state.error && (
            <div style={{ marginTop: 4, fontSize: 'var(--fs-sm)', opacity: 0.7 }}>
              {this.state.error.message}
            </div>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

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
  const ctxReady = useCtxReady()
  const ctx = tryGetCtx()

  const slots = ctx?.get('slots') ?? null

  const entries = useSlotEntries(slots, name, entryKey, filter)

  if (!ctxReady || !slots || entries.length === 0) {
    return fallback
  }

  const entry = entries[entries.length - 1]
  const Component = entry.component as ComponentType<any>

  if (!Component) {
    return fallback
  }

  const eKey = entry.options.id ?? entry.options.priority ?? 0

  return (
    <SlotRendererErrorBoundary slotName={name} fallback={fallback} entryKey={eKey}>
      <Component {...props} {...(entry.inject?.() || {})} />
    </SlotRendererErrorBoundary>
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
  const ctxReady = useCtxReady()
  const ctx = tryGetCtx()

  const slots = ctx?.get('slots') ?? null

  const entries = useSlotEntries(slots, name, undefined, filter)

  if (!ctxReady || !slots || entries.length === 0) {
    return fallback
  }

  return entries.map((entry, i) => {
    const Component = entry.component as ComponentType<any>
    if (!Component) return null
    const eKey = entry.options.id ?? i
    return (
      <SlotRendererErrorBoundary key={entry.options.id || i} slotName={`${name}[${i}]`} fallback={null} entryKey={eKey}>
        <Component {...props} {...(entry.inject?.() || {})} />
      </SlotRendererErrorBoundary>
    )
  })
}

/**
 * DSH-aligned: useSyncExternalStore 仅用于变更通知，getSnapshot 返回 number（版本号）。
 * subscribe / getSnapshot 闭包用 WeakMap 按 source 身份缓存，永不在渲染中重建。
 */
const EMPTY_ENTRIES: readonly StoredEntry[] = Object.freeze([])
const noopSubscribe = (_onChange: () => void) => () => {}
const noopGetVersion = () => 0

interface CachedSubscription {
  subscribe: (onChange: () => void) => () => void
  getVersion: () => number
}
const subscriptionCache = new WeakMap<object, Map<string, CachedSubscription>>()

function getSubscription(slots: any, key: string): CachedSubscription {
  if (!slots) return { subscribe: noopSubscribe, getVersion: noopGetVersion }
  let perSlots = subscriptionCache.get(slots)
  if (!perSlots) {
    perSlots = new Map()
    subscriptionCache.set(slots, perSlots)
  }
  let cached = perSlots.get(key)
  if (!cached) {
    cached = {
      subscribe: (onChange: () => void) => slots.subscribe(key, onChange),
      getVersion: () => slots.getVersion(key),
    }
    perSlots.set(key, cached)
  }
  return cached
}

function useSlotEntries(
  slots: any,
  key: string,
  entryKey?: string,
  filter?: (entry: StoredEntry) => boolean,
): readonly StoredEntry[] {
  const sub = getSubscription(slots, key)
  useSyncExternalStore(sub.subscribe, sub.getVersion, noopGetVersion)
  if (!slots) return EMPTY_ENTRIES
  let entries = slots.entriesOfSlot(key) as readonly StoredEntry[]
  if (entryKey) {
    entries = entries.filter(e => e.options.key === entryKey)
  }
  if (filter) {
    entries = entries.filter(filter)
  }
  return entries
}
