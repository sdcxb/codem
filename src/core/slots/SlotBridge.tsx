/**
 * SlotBridge — 连接 App.tsx 和 Cordis Slot Registry 的桥梁组件。
 *
 * 工作原理：
 * 1. 从 Slot Registry 获取注册的组件（如果存在）
 * 2. 如果存在，渲染该组件并传递所有 props
 * 3. 如果不存在，渲染 fallback 组件并传递所有 props
 * 4. 当 showDegraded=true 且使用 fallback 时，显示降级提示横幅
 *
 * 健壮性增强：
 * - 插件组件渲染崩溃时，由 SlotErrorBoundary 捕获，自动回退到 fallback
 * - Context 未初始化时，fallback 正常渲染（不静默 null）
 * - fallback={null} 的 slot 在 entries 为空时输出诊断日志
 * - SlotListBridge 在 slots 服务不可用时输出警告
 *
 * 动态 Fallback 机制：
 * - useSyncExternalStore 订阅 Slot entries 变化
 * - 插件 disable → fiber.dispose() → slot 注销 → entries 变空 → 自动回退到 fallback
 * - 插件 enable → fiber 重新加载 → slot 注册 → entries 恢复 → 自动切回插件组件
 *
 * 使用方式：
 * ```tsx
 * <SlotBridge name="app.sidebar" fallback={Sidebar} showDegraded {...sidebarProps} />
 * <SlotBridge name="app.conversation" fallback={ChatPanel} showDegraded {...chatProps} />
 * ```
 */
import { useSyncExternalStore, Suspense, useState, useEffect, type ComponentType, type ReactNode, Component } from 'react'
import { tryGetCtx } from '../consumer/index.ts'
import type { StoredEntry } from '../slots/index.ts'

/**
 * 插件组件错误边界 — 当插件组件本身崩溃时，自动回退到 fallback。
 * 与 FallbackErrorBoundary 不同：这个包裹的是插件组件，不是 fallback。
 */
class SlotErrorBoundary extends Component<
  { children: ReactNode; slotName: string; fallback?: ReactNode },
  { hasError: boolean; error?: Error }
> {
  state: { hasError: boolean; error?: Error } = { hasError: false }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error(`[SlotBridge] Plugin component crashed for slot "${this.props.slotName}":`, error.message)
  }

  componentDidUpdate() {
    // 当 children 变化时重置 error 状态，让插件有机会重新渲染
    if (this.state.hasError && this.props.children !== this._lastChildren) {
      this._lastChildren = this.props.children
      this.setState({ hasError: false, error: undefined })
    }
  }
  _lastChildren: ReactNode = null

  render() {
    if (this.state.hasError) {
      // 如果有 fallback，使用 fallback；否则显示错误提示
      if (this.props.fallback) return this.props.fallback
      return (
        <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          ⚠️ 插件组件崩溃（slot: {this.props.slotName}）
        </div>
      )
    }
    this._lastChildren = this.props.children
    return this.props.children
  }
}

/**
 * D4-4: 级联降级错误边界 — 当 Fallback 组件本身依赖被禁用的 Provider 而崩溃时，显示错误提示而非白屏。
 */
class FallbackErrorBoundary extends Component<{ children: ReactNode; slotName: string }, { hasError: boolean; error?: Error }> {
  state: { hasError: boolean; error?: Error } = { hasError: false }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.warn(`[SlotBridge] Fallback component crashed for slot "${this.props.slotName}":`, error.message)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          ⚠️ 此面板不可用（组件依赖的服务被禁用）
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
        // fallback={null} 的 slot — 输出诊断日志，不静默消失
        <NullFallbackDiagnostic slotName={name} />
      )}
    </>
  )
}

/**
 * 当 fallback={null} 且 entries 为空时，输出一次性诊断日志。
 * 不渲染任何可见 UI，但在控制台留下痕迹。
 */
function NullFallbackDiagnostic({ slotName }: { slotName: string }) {
  useEffect(() => {
    console.debug(`[SlotBridge] Slot "${slotName}" has no entries and no fallback (silent)`)
  }, [slotName])
  return null
}

/**
 * 泛型 SlotBridge：从 fallback 组件的 Props 类型自动推断 props 类型。
 */
export function SlotBridge<P extends Record<string, any> = Record<string, any>>(
  props: { name: string } & { fallback?: ComponentType<P> | null; showDegraded?: boolean } & P
): ReactNode {
  const { name, fallback: Fallback, showDegraded, ...rest } = props
  const ctx = tryGetCtx()

  // 如果 Cordis Context 未初始化或 Slot 服务不可用，使用 fallback
  const slots = ctx?.get('slots') ?? null

  // D7-1 修复: Hook 必须无条件调用，避免 React Hooks 顺序违规
  const entries = useSlotEntriesSafe(slots, name)
  const isDegraded = entries.length === 0

  if (!slots) {
    // Context 未初始化 — 使用 fallback，不静默返回 null
    return renderFallback(Fallback, rest as Record<string, any>, name, showDegraded)
  }

  if (isDegraded) {
    // 没有注册的组件，使用 fallback
    return renderFallback(Fallback, rest as Record<string, any>, name, showDegraded)
  }

  // 取最高优先级的注册组件
  const entry = entries[entries.length - 1]
  const Component = entry.component as ComponentType<P>

  if (!Component) {
    return renderFallback(Fallback, rest as Record<string, any>, name, showDegraded)
  }

  // 插件组件用 SlotErrorBoundary 包裹：崩溃时自动回退到 fallback
  const fallbackNode = Fallback ? (
    <FallbackErrorBoundary slotName={name}>
      <Fallback {...(rest as unknown as P)} />
    </FallbackErrorBoundary>
  ) : null

  return (
    <Suspense fallback={<div className="slot-loading">Loading...</div>}>
      <SlotErrorBoundary slotName={name} fallback={fallbackNode}>
        <Component {...(rest as unknown as P)} />
      </SlotErrorBoundary>
    </Suspense>
  )
}

/**
 * P1-2: 降级提示横幅 — 当插件被关闭导致 Slot 空时显示提示。
 */
function DegradedBanner({ slotName }: { slotName: string }) {
  const [dismissed, setDismissed] = useState(false)

  // 监听插件状态变化，重置 dismissed
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
 * 用于 overlay 类型的 slot（如 app.overlay）。
 */
export function SlotListBridge<P extends Record<string, any>>(
  props: { name: string } & P
): ReactNode {
  const { name, ...rest } = props
  const ctx = tryGetCtx()

  const slots = ctx?.get('slots')
  if (!slots) {
    // 健壮性增强：slots 服务不可用时输出警告，而非静默返回 null
    console.warn(`[SlotListBridge] Slots service not available for "${name}" — rendering nothing`)
    return null
  }

  const entries = useSlotEntries(slots, name)

  if (entries.length === 0) {
    return null
  }

  return entries.map((entry, i) => {
    const Component = entry.component as ComponentType<P>
    if (!Component) return null
    return (
      <Suspense key={entry.options.id || i} fallback={null}>
        <SlotErrorBoundary slotName={`${name}[${i}]`} fallback={null}>
          <Component {...(rest as unknown as P)} />
        </SlotErrorBoundary>
      </Suspense>
    )
  })
}

/**
* D7-1: 当 slots 为 null 时使用的 no-op 订阅 — getSnapshot 必须返回缓存的稳定引用，
* 否则 useSyncExternalStore 会无限循环（React 要求 getSnapshot 返回值引用稳定）。
*/
const EMPTY_ENTRIES: StoredEntry[] = []
const noopSubscribe = (_onChange: () => void) => () => {}
const noopGetSnapshot = () => EMPTY_ENTRIES

/**
* Hook: 订阅 Slot 的 entries 变化。
* 当 slots 为 null 时返回空数组（避免 Hooks 顺序违规）。
*/
function useSlotEntriesSafe(slots: any, key: string): StoredEntry[] {
  return useSyncExternalStore(
    slots ? (onChange) => slots.subscribe(key, onChange) : noopSubscribe,
    slots ? () => slots.entriesOfSlot(key) as StoredEntry[] : noopGetSnapshot,
    noopGetSnapshot,
  )
}

/**
* Hook: 订阅 Slot 的 entries 变化（原版，保留向后兼容）。
*/
function useSlotEntries(slots: any, key: string): StoredEntry[] {
  return useSyncExternalStore(
    (onChange) => slots.subscribe(key, onChange),
    () => {
      const entries = slots.entriesOfSlot(key) as StoredEntry[]
      return entries
    },
    () => [] as StoredEntry[],
  )
}
