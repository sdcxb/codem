/**
 * SlotBridge — 连接 App.tsx 和 Cordis Slot Registry 的桥梁组件。
 *
 * 对标 DSH scoped-slots.tsx 的 SlotOutlet + renderOutletContent 模式：
 * - useSyncExternalStore 订阅 slot version 变化
 * - 渲染体中读取 entries，按 kind 分派
 * - SlotErrorBoundary 按入 entry-identity 做 key，崩溃时自动回退
 * - 不使用 React.lazy / Suspense — DSH 完全不用 lazy，组件同步导入
 *
 * DSH scoped-slots.tsx 的核心设计：
 * 1. subscribe / getSnapshot 闭包用 WeakMap 按 source 身份缓存
 * 2. getSnapshot 返回 number（版本号），值类型天然引用稳定
 * 3. entries 在渲染体中读取，不在 getSnapshot 中
 * 4. 每个 entry 用 SlotErrorBoundary 包裹，key=entryKeyOf(entry)
 * 5. 崩溃的 entry 通过 reportEntryError abdicate，触发重渲染到下一个 survivor
 */
import { useSyncExternalStore, useState, useEffect, type ComponentType, type ReactNode, Component } from 'react'
import { tryGetCtx, onCtxReady, useCtxReady } from '../consumer/index.ts'
import type { StoredEntry } from '../slots/index.ts'

/**
 * 插件组件错误边界 — 对标 DSH scoped-slots.tsx SlotErrorBoundary。
 * 当插件组件崩溃时，自动回退到 fallback。
 * entryKey 变化时重置错误状态（entry 替换、abdicate 后回退到下一个 survivor）。
 */
class SlotErrorBoundary extends Component<
  { children: ReactNode; slotName: string; fallback?: ReactNode; entryKey?: string | number },
  { hasError: boolean; error?: Error }
> {
  state: { hasError: boolean; error?: Error } = { hasError: false }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error(`[SlotBridge] Plugin component crashed for slot "${this.props.slotName}":`, error)
  }

  componentDidUpdate(prevProps: Readonly<{ children: ReactNode; slotName: string; fallback?: ReactNode; entryKey?: string | number }>) {
    // 对标 DSH scoped-slots.tsx:296 entryKeyOf 模式：
    // entry 变化时重置错误状态，让新组件有机会正常渲染。
    if (this.state.hasError && prevProps.entryKey !== this.props.entryKey) {
      this.setState({ hasError: false, error: undefined })
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div data-slot-error={this.props.slotName} style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          ⚠️ 插件组件崩溃（slot: {this.props.slotName}）
          {this.state.error && (
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
              {this.state.error.message}
            </div>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 级联降级错误边界 — 当 Fallback 组件本身崩溃时，显示错误提示而非白屏。
 */
class FallbackErrorBoundary extends Component<{ children: ReactNode; slotName: string }, { hasError: boolean; error?: Error }> {
  state: { hasError: boolean; error?: Error } = { hasError: false }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.warn(`[SlotBridge] Fallback component crashed for slot "${this.props.slotName}":`, error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div data-slot-error={this.props.slotName} style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          ⚠️ 此面板不可用（组件依赖的服务被禁用）
          {this.state.error && (
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
              {this.state.error.message}
            </div>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

// ====== 渲染 fallback 的公共逻辑 ======

function renderFallback(
  Fallback: ComponentType<any> | null | undefined,
  rest: Record<string, any>,
  name: string,
  showDegraded: boolean | undefined,
): ReactNode {
  return (
    <>
      {showDegraded && <DegradedBanner slotName={name} />}
      {Fallback ? (
        <FallbackErrorBoundary slotName={name}>
          <Fallback {...rest} />
        </FallbackErrorBoundary>
      ) : (
        <NullFallbackDiagnostic slotName={name} />
      )}
    </>
  )
}

/**
 * 当 fallback={null} 且 entries 为空时，输出一次性诊断日志。
 */
function NullFallbackDiagnostic({ slotName }: { slotName: string }) {
  useEffect(() => {
    console.debug(`[SlotBridge] Slot "${slotName}" has no entries and no fallback (silent)`)
  }, [slotName])
  return null
}

/**
 * 泛型 SlotBridge：从 fallback 组件的 Props 类型自动推断 props 类型。
 *
 * 对标 DSH scoped-slots.tsx SlotOutlet：
 * - useSyncExternalStore 订阅 slot version
 * - 渲染体中读取 entries
 * - 取 winner entry，用 SlotErrorBoundary 包裹
 * - 不使用 Suspense — 组件同步导入
 */
export function SlotBridge<P extends Record<string, any> = Record<string, any>>(
  props: { name: string } & { fallback?: ComponentType<P> | null; showDegraded?: boolean } & P
): ReactNode {
  const { name, fallback: Fallback, showDegraded, ...rest } = props

  const ctxReady = useCtxReady()
  const ctx = tryGetCtx()

  const slots = ctx?.get('slots') ?? null

  // D7-1 修复: Hook 必须无条件调用，避免 React Hooks 顺序违规
  const entries = useSlotEntriesSafe(slots, name)
  const isDegraded = entries.length === 0

  // ctx 未就绪时渲染 fallback 但不显示降级横幅
  if (!ctxReady || !slots) {
    return renderFallback(Fallback, rest as Record<string, any>, name, false)
  }

  if (isDegraded) {
    return renderFallback(Fallback, rest as Record<string, any>, name, showDegraded)
  }

  // 取最高优先级的注册组件（对标 DSH entriesOfSlot 的 shadowing winner）
  const entry = entries[entries.length - 1]
  const Component = entry.component as ComponentType<P>

  if (!Component) {
    return renderFallback(Fallback, rest as Record<string, any>, name, showDegraded)
  }

  // 对标 DSH scoped-slots.tsx:296 entryKeyOf 模式
  const entryKey = entry.options.id ?? entry.options.priority ?? 0

  const fallbackNode = Fallback ? (
    <FallbackErrorBoundary slotName={name}>
      <Fallback {...(rest as unknown as P)} />
    </FallbackErrorBoundary>
  ) : null

  return (
    <SlotErrorBoundary slotName={name} fallback={fallbackNode} entryKey={entryKey}>
      <Component {...(rest as unknown as P)} />
    </SlotErrorBoundary>
  )
}

/**
 * P1-2: 降级提示横幅
 */
function DegradedBanner({ slotName }: { slotName: string }) {
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const handler = () => setDismissed(false)
    window.addEventListener('codem:plugin-state-changed', handler)
    return () => window.removeEventListener('codem:plugin-state-changed', handler)
  }, [])

  if (dismissed) return null

  return (
    <div style={{
      padding: '4px 12px',
      background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
      borderBottom: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)',
      fontSize: 11,
      color: 'var(--text-secondary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}>
      <span>⚠️ 此面板使用默认组件（插件已关闭：{slotName}）</span>
      <button
        onClick={() => setDismissed(true)}
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
      >
        ×
      </button>
    </div>
  )
}

/**
 * 渲染 list 类型 slot 中的所有组件。
 * 对标 DSH scoped-slots.tsx list 分支。
 */
export function SlotListBridge<P extends Record<string, any>>(
  props: { name: string } & P
): ReactNode {
  const { name, ...rest } = props

  const ctxReady = useCtxReady()
  const ctx = tryGetCtx()

  const slots = ctx?.get('slots') ?? null

  const entries = useSlotEntriesSafe(slots, name)

  if (!ctxReady || !slots || entries.length === 0) {
    return null
  }

  return entries.map((entry, i) => {
    const Component = entry.component as ComponentType<P>
    if (!Component) return null
    const entryKey = entry.options.id ?? i
    return (
      <SlotErrorBoundary key={entry.options.id || i} slotName={`${name}[${i}]`} fallback={null} entryKey={entryKey}>
        <Component {...(rest as unknown as P)} />
      </SlotErrorBoundary>
    )
  })
}

/**
 * DSH-aligned: useSyncExternalStore 仅用于变更通知，getSnapshot 返回 number（版本号）。
 *
 * DSH 的设计（scoped-slots.tsx:661 + bind.ts:18）：
 * - subscribe / getSnapshot 闭包用 WeakMap 按 source 身份缓存，永不在渲染中重建
 * - getSnapshot 返回 number（版本号），值类型天然引用稳定
 * - entries 在渲染体中读取，不在 getSnapshot 中
 */
const EMPTY_ENTRIES: readonly StoredEntry[] = Object.freeze([])
const noopSubscribe = (_onChange: () => void) => () => {}
const noopGetVersion = () => 0

/** 按 (slots, key) 缓存 subscribe + getSnapshot 闭包对，对齐 DSH 的 WeakMap 模式 */
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

/**
 * Hook: 订阅 Slot 的 version 变化，在渲染体中读取 entries。
 * 当 slots 为 null 时返回空数组（避免 Hooks 顺序违规）。
 */
function useSlotEntriesSafe(slots: any, key: string): readonly StoredEntry[] {
  const sub = getSubscription(slots, key)
  useSyncExternalStore(sub.subscribe, sub.getVersion, noopGetVersion)
  if (!slots) return EMPTY_ENTRIES
  return slots.entriesOfSlot(key) as readonly StoredEntry[]
}
