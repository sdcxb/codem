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
import { Fragment, useSyncExternalStore, useState, useEffect, type ComponentType, type ReactNode, Component } from 'react'
import { tryGetCtx, onCtxReady, useCtxReady } from '../consumer/index.ts'
import type { StoredEntry } from '../slots/index.ts'
import { ActionIcons } from "../../core/icons/icon-map";
import { reportActionFailure } from "../storage/persist-failure";

/**
 * 插件组件错误边界 — 对标 DSH scoped-slots.tsx SlotErrorBoundary。
 * 当插件组件崩溃时，自动回退到 fallback。
 * entryKey 变化时重置错误状态（entry 替换、abdicate 后回退到下一个 survivor）。
 */
class SlotErrorBoundary extends Component<
  { children: ReactNode; slotName: string; fallback?: ReactNode; entryKey?: string | number },
  { hasError: boolean; error?: Error; attempt: number }
> {
  state: { hasError: boolean; error?: Error; attempt: number } = { hasError: false, attempt: 0 }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    // 插件组件崩了 → 走仓库既有失败通道（action：该槽位本次没有渲染出插件内容）
    reportActionFailure(`slotBridge.${this.props.slotName}.plugin`, error, "插件组件崩溃，已回退到降级组件")
  }

  componentDidUpdate(prevProps: Readonly<{ children: ReactNode; slotName: string; fallback?: ReactNode; entryKey?: string | number }>) {
    // 对标 DSH scoped-slots.tsx:296 entryKeyOf 模式：
    // entry 变化时重置错误状态，让新组件有机会正常渲染。
    if (this.state.hasError && prevProps.entryKey !== this.props.entryKey) {
      this.setState({ hasError: false, error: undefined })
    }
  }

  /**
   * 用户自助重试：复位错误态并重建子树（attempt 进 key）。
   * 原来没有这个入口 —— entry 不变时 `hasError` 永远为真，用户只能重启。
   */
  handleRetry = () => {
    this.setState((prev) => ({ hasError: false, error: undefined, attempt: prev.attempt + 1 }))
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return (
          <Fragment key={`fb-${this.state.attempt}`}>
            <MinimalRetryRow slotName={this.props.slotName} error={this.state.error} onRetry={this.handleRetry} />
            {this.props.fallback}
          </Fragment>
        )
      }
      return (
        <div data-slot-error={this.props.slotName} style={{ padding: '8px 12px', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          ⚠️ 插件组件崩溃（slot: {this.props.slotName}）
          {this.state.error && (
            <div style={{ marginTop: 4, fontSize: 'var(--fs-sm)', opacity: 0.7 }}>
              {this.state.error.message}
            </div>
          )}
          <MinimalRetryRow slotName={this.props.slotName} error={this.state.error} onRetry={this.handleRetry} />
        </div>
      )
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}

/** 崩溃态下的"重试"一行（SlotErrorBoundary 用）。 */
function MinimalRetryRow({
  slotName,
  error,
  onRetry,
}: {
  slotName: string
  error?: Error
  onRetry: () => void
}): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        插件内容未能渲染，已回退到默认组件
        {error?.message ? `（${error.message.length > 60 ? `${error.message.slice(0, 60)}…` : error.message}）` : ''}
      </span>
      <button
        type="button"
        onClick={onRetry}
        data-slot-action={`retry-plugin:${slotName}`}
        style={{
          background: 'none',
          border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          fontSize: 'var(--fs-sm)',
          padding: '2px 8px',
        }}
      >
        重试
      </button>
    </div>
  )
}

/**
 * 级联降级错误边界 — 当 Fallback 组件本身崩溃时，显示错误提示而非白屏。
 *
 * P1-2 修复（原实现有四个问题）：
 *   ① 崩溃后 `hasError` **永不复位** —— 只要 mount 时抛过一次，这个槽位就永久
 *      变成一行"⚠️ 此面板不可用（组件依赖的服务被禁用）"，直到重启应用；
 *   ② 提示文案里的"组件依赖的服务被禁用"是**猜的原因**：崩溃可能是任何异常；
 *   ③ 用户没有任何自助恢复入口（没有重试按钮）；
 *   ④ 失败只走 `console.warn`，不进仓库既有的失败上报通道，用户与诊断都看不见。
 *
 * 现在：崩溃后给"重试"入口（递增 key 强制重建子树）+ 指数退避 + 次数上限；
 * 次数用尽则**降级成"该槽位缺失"的最小可视形态**（只有一行说明，不再占满面板），
 * 并且每一次崩溃都经 `reportActionFailure` 如实上报（kind=action：该面板本次没渲染出来）。
 */
interface FallbackErrorBoundaryProps {
  children: ReactNode
  slotName: string
}

interface FallbackErrorBoundaryState {
  hasError: boolean
  error?: Error
  /** 剩余重试次数（0 = 已用尽，只剩"重新加载"这条路）。 */
  retryBudget: number
  /** 递增后作为 children 的 key，用来**强制重建**子树（否则 React 复用崩溃实例）。 */
  attempt: number
}

/**
 * 重试上限（每挂载一次）：同一个 fallback 在这个实例里最多重试这么多次，
 * 用尽后不再重建，直接显示"该槽位缺失"的最小可视形态。
 * 计数随实例走 —— entry 变化（entryKey 变）或父级重挂时自然拿到新的预算。
 */
export const SLOT_FALLBACK_MAX_RETRIES = 2

/** 第 n 次重试前的等待（指数退避），避免"点一下崩一下"的重试风暴。 */
export function slotRetryBackoffMs(attemptSoFar: number): number {
  return 300 * Math.pow(2, Math.max(0, attemptSoFar))
}

class FallbackErrorBoundary extends Component<FallbackErrorBoundaryProps, FallbackErrorBoundaryState> {
  state: FallbackErrorBoundaryState = { hasError: false, retryBudget: SLOT_FALLBACK_MAX_RETRIES, attempt: 0 }

  /** 退避定时器：卸载时必须清，否则卸载后还会去 setState。 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError(error: Error): Partial<FallbackErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    // 如实上报：这个槽位本次没有渲染出内容（kind=action），界面同时给出说明与重试入口。
    reportActionFailure(
      `slotBridge.${this.props.slotName}.fallback`,
      error,
      `槽位「${this.props.slotName}」的降级组件崩溃，已回退为「该槽位缺失」的最小形态` +
        (this.state.retryBudget > 0 ? `（仍可重试 ${this.state.retryBudget} 次）` : "（重试次数已用尽）"),
    )
  }

  componentWillUnmount() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  handleRetry = () => {
    if (this.retryTimer !== null) return // 退避窗口内的重复点击直接忽略
    const budget = this.state.retryBudget
    if (budget <= 0) return
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        // 只允许在仍然处于错误态时复位；期间 entry 变了则由 SlotErrorBoundary 的
        // entryKey 分支或父级重挂处理。
        if (!this.state.hasError) return
        this.setState((prev) => ({
          hasError: false,
          error: undefined,
          retryBudget: prev.retryBudget - 1,
          attempt: prev.attempt + 1,
        }))
      },
      slotRetryBackoffMs(SLOT_FALLBACK_MAX_RETRIES - budget),
    )
  }

  render() {
    if (this.state.hasError) {
      return <SlotMissingNotice slotName={this.props.slotName} state={this.state} onRetry={this.handleRetry} />
    }
    // attempt 作为 key：重试时强制废弃崩溃过的子树实例，重新走一遍 mount。
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}

/**
 * 「该槽位缺失」的最小可视形态（P1-2 要求②）：
 * 只用一行说明 + 一个重试入口占位，不让整个插槽区域变成不可用。
 */
function SlotMissingNotice({
  slotName,
  state,
  onRetry,
}: {
  slotName: string
  state: FallbackErrorBoundaryState
  onRetry: () => void
}): ReactNode {
  const exhausted = state.retryBudget <= 0
  const message = exhausted
    ? "⚠️ 此面板不可用（降级组件持续失败，已停止自动重试；可重新加载应用）"
    : "⚠️ 此面板不可用（降级组件崩溃）"
  return (
    <div
      data-slot-error={slotName}
      data-slot-missing={slotName}
      role="status"
      style={{ padding: '2px 12px', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
    >
      <span>{message}</span>
      {state.error && (
        <span title={state.error.message} style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }}>
          {state.error.message.length > 60 ? `${state.error.message.slice(0, 60)}…` : state.error.message}
        </span>
      )}
      {!exhausted && (
        <button
          type="button"
          onClick={onRetry}
          data-slot-action={`retry-fallback:${slotName}`}
          style={{
            background: 'none',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: 'var(--fs-sm)',
            padding: '2px 8px',
          }}
        >
          重试（剩余 {state.retryBudget} 次）
        </button>
      )}
    </div>
  )
}

// ====== 渲染 fallback 的公共逻辑 ======

function renderFallback(
  Fallback: ComponentType<any> | null | undefined,
  rest: Record<string, any>,
  name: string,
  showDegraded: boolean | undefined,
): ReactNode {
  return (
    // degraded 横幅与 fallback **一起**进同一个边界：横幅本身崩了也不能带走整个插槽
    // （第 44 轮 P1-2：原来横幅在边界外，它一崩整个槽位区域直接不可用）。
    <SlotErrorBoundary slotName={name}>
      {showDegraded && <DegradedBanner slotName={name} />}
      {Fallback ? (
        <FallbackErrorBoundary slotName={name}>
          <Fallback {...rest} />
        </FallbackErrorBoundary>
      ) : (
        <NullFallbackDiagnostic slotName={name} />
      )}
    </SlotErrorBoundary>
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

  // 取最高优先级的注册组件（对标 DSH entriesOfSlot 的 shadowing winner）。
  // 不依赖数组顺序：entriesOfSlot 对 list 是升序、对 single/keyed 是降序，
  // 直接按 priority 取最大值最稳。
  const entry = entries.reduce(
    (best, e) => ((e.options.priority ?? 0) >= (best.options.priority ?? 0) ? e : best),
    entries[0],
  )
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
      fontSize: 'var(--fs-sm)',
      color: 'var(--text-secondary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}>
      <span>⚠️ 此面板使用默认组件（插件已关闭：{slotName}）</span>
      <button
        onClick={() => setDismissed(true)}
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-sm)' }}
        aria-label="关闭"
      >
        <ActionIcons.close size={14} />
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

/**
 * Hook: 某个 slot 当前是否有插件贡献。
 *
 * 宿主用它来决定「扩展页签 / 扩展区块」是否显示 ——
 * 插件被禁用时不装配 provider → 这里返回 false → 宿主 UI 完全回到原样
 * （例如任务管理的「图书馆」页签只在 ui-library-ops 启用时出现）。
 */
export function useSlotHasEntries(name: string): boolean {
  const ctxReady = useCtxReady()
  const ctx = tryGetCtx()
  const slots = ctx?.get('slots') ?? null
  const entries = useSlotEntriesSafe(slots, name)
  return ctxReady && !!slots && entries.length > 0
}
