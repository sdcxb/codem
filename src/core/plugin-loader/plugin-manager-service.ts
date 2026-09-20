// @ts-nocheck
/**
 * PluginManagerService — 插件开关管理服务。
 *
 * 管理插件的启用/禁用状态，处理依赖关系，与 Cordis Context 联动。
 *
 * 核心功能：
 * 1. 维护插件启用/禁用状态（持久化：**DB 权威** + localStorage 镜像，走 `saveDisabledPlugins`）
 * 2. 关闭插件时检查依赖，返回级联关闭列表
 * 3. 启用插件时检查依赖，自动启用缺失的依赖
 * 4. 与 Cordis Context 联动（实际加载/卸载 Provider）
 */

import { PluginDependencyGraph, type PluginMeta, type CascadeDisableResult, type CascadeEnableResult } from './dependency-graph'
import type { Context } from '../cordis/src/index.ts'
import { builtinPlugins } from './index'
import { getActiveFiber, unregisterActiveFiber } from './yaml-loader'
import { saveDisabledPlugins as persistDisabledPlugins, reconcileDisabledPluginsAtBoot } from '../session/preferences'

/** 插件状态 */
export type PluginStatus = 'enabled' | 'disabled' | 'loading' | 'error'

/** 插件状态记录 */
export interface PluginStateRecord {
  name: string
  status: PluginStatus
  /** 错误信息（如果有） */
  error?: string
  /** 最后更新时间 */
  updatedAt: number
}

/** 关闭插件的确认请求 */
export interface DisableConfirmationRequest {
  /** 要关闭的目标插件 */
  targetPlugin: string
  /** 级联关闭列表（包含目标插件和所有依赖它的插件） */
  cascadeList: CascadeDisableResult
  /** 用户确认回调 */
  resolve: (confirmed: boolean) => void
  /** 风险等级 */
  riskLevel?: 'safe' | 'caution' | 'danger'
  /** 风险描述 */
  riskDescription?: string
}

/**
 * 插件管理器服务。
 *
 * 使用方式：
 * ```typescript
 * const manager = new PluginManagerService(ctx, graph)
 * await manager.initialize()
 *
 * // 获取所有插件状态
 * manager.getPluginStates()
 *
 * // 关闭插件（返回确认请求如果有级联依赖）
 * const result = await manager.disable('@codem/fs-local')
 * if (result.needsConfirmation) {
 *   // 显示确认对话框
 *   showConfirmDialog(result.cascadeList)
 * }
 * ```
 */
export class PluginManagerService {
  private graph: PluginDependencyGraph
  private ctx: Context
  private states = new Map<string, PluginStateRecord>()
  /** fiber 句柄（用于卸载） */
  private fibers = new Map<string, any>()
  /** 确认请求回调（UI 层设置） */
  private confirmationCallback: ((req: DisableConfirmationRequest) => Promise<boolean>) | null = null

  /** 插件加载器映射（name → apply 函数） */
  private pluginLoaders = new Map<string, () => any>()

  /** 状态变化监听器 */
  private listeners = new Set<() => void>()

  constructor(ctx: Context, graph: PluginDependencyGraph) {
    this.ctx = ctx
    this.graph = graph
  }

  /**
   * 设置确认回调——UI 层用来处理级联关闭的确认对话框。
   */
  setConfirmationCallback(cb: (req: DisableConfirmationRequest) => Promise<boolean>): void {
    this.confirmationCallback = cb
  }

  /**
   * 注册一个插件的加载器函数。
   */
  registerPluginLoader(name: string, applyFn: () => any): void {
    this.pluginLoaders.set(name, applyFn)
  }

  /** 默认禁用的插件列表（首次运行时自动禁用） */
  private DEFAULT_DISABLED = ['@codem/ui-game']

  /**
   * 初始化：从 localStorage 恢复状态，同步当前已加载的插件。
   */
  async initialize(): Promise<void> {
    // 自动填充 loader：内置插件（builtinPlugins）的"启用" = ctx.plugin 真加载。
    // （此前生产从不注册 loader → enable/disable 只改状态，从不真正加载/卸载
    // ctx 插件——禁用 = 假禁用。builtin 全量在此登记 loader 后修复。）
    for (const [name, entry] of builtinPlugins) {
      if (!this.pluginLoaders.has(name)) {
        this.pluginLoaders.set(name, () => entry.apply())
      }
    }

    /**
     * 恢复禁用列表 —— 第 48 轮起走**与 App 启动同一套对账**
     * （`reconcileDisabledPluginsAtBoot`：DB 权威 + 时间戳判定哪一份更新）。
     *
     * 为什么不能继续只读 localStorage：面板里的开关状态来自这里，
     * 而工具条/面板的显隐来自 App 的 `pluginDisabledList`（读 DB）。
     * 两者各读一份介质时，只要两份不一致，就会出现"面板说已禁用、按钮还在"
     * 这种自相矛盾的界面 —— 用户无从判断哪个是真的。
     */
    let disabledList: string[]
    try {
      const reconciled = reconcileDisabledPluginsAtBoot()
      disabledList = reconciled.list
      if (reconciled.seeded) {
        console.log('[PluginManager] 首次运行：使用默认禁用列表', disabledList)
      }
      if (reconciled.diverged) {
        console.warn(
          '[PluginManager] 禁用列表的两种介质不一致，已按',
          reconciled.adoptedFromMirror ? '镜像（更新的一份）' : 'DB（权威介质）',
          '对齐',
        )
      }
    } catch (e) {
      console.warn('[PluginManager] 禁用列表对账失败，回落 localStorage 镜像:', e)
      const fallback = this.loadDisabledList()
      disabledList = fallback === null ? [...this.DEFAULT_DISABLED] : fallback
    }

    // 所有已注册插件默认为 enabled
    for (const meta of this.graph.list()) {
      const isDisabled = disabledList.includes(meta.name)
      this.states.set(meta.name, {
        name: meta.name,
        status: isDisabled ? 'disabled' : 'enabled',
        updatedAt: Date.now(),
      })
    }

    // 对已禁用的插件，尝试卸载
    for (const name of disabledList) {
      this.doDisable(name)
    }

    console.log(`[PluginManager] Initialized with ${this.states.size} plugins (${disabledList.length} disabled)`)
    this.notifyListeners()
  }

  /**
   * 获取依赖图（供 UI 层查询依赖关系）。
   */
  getDependencyGraph(): PluginDependencyGraph {
    return this.graph
  }

  /**
   * 获取所有插件的状态（合并元数据 + 状态 + 依赖信息）。
   */
  getPluginStates(): Array<PluginMeta & {
    status: PluginStatus
    error?: string
    dependencies: string[]
    dependents: string[]
    dependencyDescription: string
    canSafelyDisable: boolean
  }> {
    return this.graph.list().map(meta => {
      const state = this.states.get(meta.name)
      const depInfo = this.graph.getDependencyInfo(meta.name)
      return {
        ...meta,
        status: state?.status ?? 'disabled',
        error: state?.error,
        dependencies: depInfo.dependencies,
        dependents: depInfo.dependents,
        dependencyDescription: depInfo.dependencyDescription,
        canSafelyDisable: this.graph.canSafelyDisable(meta.name),
      }
    })
  }

  /**
   * 获取单个插件的状态。
   */
  getPluginState(name: string): PluginStateRecord | undefined {
    return this.states.get(name)
  }

  /**
   * 启用一个插件。
   *
   * 如果插件有依赖且依赖未启用，会自动启用依赖。
   * 如果依赖未安装，返回错误。
   */
  async enable(name: string): Promise<{ success: boolean; enabledList: string[]; error?: string }> {
    const meta = this.graph.get(name)
    if (!meta) {
      return { success: false, enabledList: [], error: `Plugin "${name}" not found` }
    }

    const currentState = this.states.get(name)
    if (currentState?.status === 'enabled') {
      return { success: false, enabledList: [], error: 'Plugin is already enabled' }
    }
    if (currentState?.status === 'loading') {
      // 连点/并发保护：启用进行中，拒绝重复启用（避免同一插件二次 ctx.plugin 加载）
      return { success: false, enabledList: [], error: 'Plugin is being enabled, please wait' }
    }

    // 计算级联启用列表
    const enabledSet = new Set(
      [...this.states.entries()]
        .filter(([, s]) => s.status === 'enabled')
        .map(([n]) => n)
    )
    const cascade = this.graph.getCascadeEnable(name, enabledSet)

    if (cascade.missingDependencies.length > 0) {
      return {
        success: false,
        enabledList: [],
        error: `Missing dependencies: ${cascade.missingDependencies.join(', ')}`,
      }
    }

    // 按顺序启用（依赖在前）
    const enabledList: string[] = []
    const failures: string[] = []
    for (const pluginName of cascade.toEnable) {
      const success = await this.doEnable(pluginName)
      if (success) {
        enabledList.push(pluginName)
      } else {
        const st = this.states.get(pluginName)
        failures.push(`${pluginName}: ${st?.error || 'unknown error'}`)
      }
    }

    this.saveDisabledList()
    this.notifyListeners()
    if (failures.length > 0) {
      // 部分失败：不得报成功——UI 依据 success 决定"已启用"提示
      return { success: false, enabledList, error: `Failed to enable: ${failures.join('; ')}` }
    }
    return { success: true, enabledList }
  }

  /**
   * 禁用一个插件。
   *
   * 如果有其他插件依赖它，返回确认请求让用户确认级联关闭。
   */
  async disable(name: string): Promise<{
    success: boolean
    disabledList: string[]
    needsConfirmation: boolean
    cascadeList?: CascadeDisableResult
    /**
     * 其中**真的卸载掉了**的那些（第 63 轮新增，可选字段）。
     *
     * 为什么必须把它交给 UI：`disabledList` 只说明"状态改成 disabled 了"，
     * 不说明"卸载了"。面板原来无条件弹「已关闭 X」—— 对没有可卸载句柄的插件，
     * 那是一句**与事实相反的承诺**（插件会一直跑到重启）。有了这个字段，
     * 面板才能在"只改了状态、没卸载"时说清"需要重启"。
     */
    unloadedList?: string[]
    error?: string
  }> {
    const meta = this.graph.get(name)
    if (!meta) {
      return { success: false, disabledList: [], needsConfirmation: false, error: `Plugin "${name}" not found` }
    }

    const currentState = this.states.get(name)
    if (currentState?.status === 'disabled') {
      return { success: false, disabledList: [], needsConfirmation: false, error: 'Plugin is already disabled' }
    }
    if (currentState?.status === 'loading') {
      // 连点/并发保护：正在启用/加载中的插件不可并发禁用
      return { success: false, disabledList: [], needsConfirmation: false, error: 'Plugin is still loading, please wait' }
    }

    // 计算级联关闭
    const cascade = this.graph.getCascadeDisable(name)

    // 检查是否被锁定（核心插件不可关闭）
    if (cascade.lockedReason) {
      return { success: false, disabledList: [], needsConfirmation: false, error: cascade.lockedReason }
    }

    if (cascade.needsConfirmation && this.confirmationCallback) {
      // 需要用户确认
      const confirmed = await this.confirmationCallback({
        targetPlugin: name,
        cascadeList: cascade,
        resolve: () => {}, // 占位
      })

      if (!confirmed) {
        return { success: false, disabledList: [], needsConfirmation: true, cascadeList: cascade }
      }
    }

    // 执行级联关闭
    const disabledList: string[] = []
    const unloadedList: string[] = []
    for (const pluginName of cascade.toDisable) {
      const outcome = await this.doDisable(pluginName)
      disabledList.push(pluginName)
      if (outcome.unloaded) unloadedList.push(pluginName)
    }

    this.saveDisabledList()
    this.notifyListeners()
    return { success: true, disabledList, unloadedList, needsConfirmation: cascade.needsConfirmation }
  }

  /**
   * 实际启用一个插件（加载到 Cordis Context）。
   */
  private async doEnable(name: string): Promise<boolean> {
    const loader = this.pluginLoaders.get(name)
    if (!loader) {
      console.warn(`[PluginManager] No loader for ${name}, marking as enabled without loading`)
      this.states.set(name, { name, status: 'enabled', updatedAt: Date.now() })
      return true
    }

    try {
      this.states.set(name, { name, status: 'loading', updatedAt: Date.now() })
      this.notifyListeners()

      const plugin = loader()
      const fiber = this.ctx.plugin(plugin)
      this.fibers.set(name, fiber)

      this.states.set(name, { name, status: 'enabled', updatedAt: Date.now() })
      console.log(`[PluginManager] Enabled: ${name}`)
      return true
    } catch (err: any) {
      this.states.set(name, { name, status: 'error', error: err.message, updatedAt: Date.now() })
      console.error(`[PluginManager] Failed to enable ${name}:`, err)
      return false
    }
  }

  /**
   * 实际禁用一个插件（从 Cordis Context 卸载——对标 dsh 卸载语义）。
   *
   * 覆盖两类 fiber：
   * - manager 动态启用时 ctx.plugin 创建的（this.fibers）；
   * - YAML 装配（loadFromYaml/loadFromEntries）创建的（activeFibers 登记）。
   * 此前只处理前者且生产从不注册 loader → 对 YAML 装配插件的"禁用"仅改状态、
   * 插件/服务/工具仍在 ctx 运行（假禁用）——现真正 dispose。
   */
  private async doDisable(name: string): Promise<{ unloaded: boolean }> {
    let unloaded = false
    const fiber = this.fibers.get(name)
    if (fiber?.dispose) {
      try {
        await fiber.dispose()
        unloaded = true
      } catch (err) {
        console.warn(`[PluginManager] Error disposing ${name}:`, err)
      }
    }
    this.fibers.delete(name)

    const activeFiber = getActiveFiber(name)
    if (activeFiber?.dispose) {
      try {
        await activeFiber.dispose()
        unloaded = true
      } catch (err) {
        console.warn(`[PluginManager] Error disposing (assembled) ${name}:`, err)
      }
    }
    unregisterActiveFiber(name)

    this.states.set(name, { name, status: 'disabled', updatedAt: Date.now() })
    /**
     * 第 84 波（审计修正）：**"禁用"不等于"卸载成功"**。
     *
     * 有些插件（例如通过 `loadUIPlugins` 注册 slot 的 UI 插件）既不在 `this.fibers`
     * 也不在 YAML 装配的登记表里 —— 那时两处 dispose 都落空、什么都没卸载，
     * 原来却无条件打印 "Disabled (unloaded)" 并让 UI 弹「已关闭」，
     * 插件下一轮照样加载、面板照样渲染。现在如实区分两种情况。
     *
     * ## 第 63 轮（console 作业）：把"两种"再分成**三种**，并且不许断言没有证据的事
     *
     * 真机读数（改动前，`.preview-shot/out-pluginmanager-warning.txt`）：
     * 冷启动 20s 窗口里**没有**这条日志；`@codem/ui-game` 在
     * `codem:disabled-plugins`（镜像与 DB 都是 `["@codem/ui-game"]`）里是禁用的，
     * 而**整个启动期的日志里没有一行 `Loaded provider: ui-game`**
     * ——因为 `App.tsx:154` 明确写了"不调用 `loader.load()`"，
     * 所以 `builtinPlugins` 里的 `@codem/ui-game`（`builtin-registry.ts:520`）
     * 这次进程里**根本没有被装载**（`this.fibers` / `getActiveFiber` 双双为空就是它的直接结果）。
     *
     * 可旧文案却写死了「该插件的代码/服务仍在本次进程内运行」——
     * 那是一个**没有证据、而且与读数相反的断言**（对该插件它就是错的）。
     * 一个会撒谎的警示比没有警示更糟：它会让人去追一个不存在的"仍在运行"。
     *
     * 所以现在三态分开、各自只说证据支持的话：
     *  - 卸载成功 → info（正常路径）；
     *  - 被装载过但没有可卸载句柄（真·假禁用）→ warn，如实说"没有句柄、请重启"；
     *  - 本次进程里从未装载过（本插件启动时的实际形态）→ info，
     *    如实说"没有卸载对象，因此不需要重启"。
     */
    const everLoaded = this.fibers.has(name) || Boolean(getActiveFiber(name))
    reportDisableOutcome(name, { unloaded, everLoaded })
    return { unloaded }
  }

  /**
   * 重启一个插件（先卸载再加载）。
   */
  async restart(name: string): Promise<{ success: boolean; error?: string }> {
    await this.doDisable(name)
    const result = await this.enable(name)
    return { success: result.success, error: result.error }
  }

  /**
   * 订阅状态变化。
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private notifyListeners(): void {
    for (const fn of [...this.listeners]) fn()
    // 通知 App 层刷新插件按钮状态
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('codem:plugin-state-changed'))
    }
  }

  // ===== 持久化（第 48 轮：走共享写入器，DB 权威 + localStorage 镜像） =====
  //
  // 改前这里**只写 localStorage**（`localStorage.setItem('codem:disabled-plugins', …)`），
  // DB 那一份只能靠 App 监听 `codem:plugin-state-changed` 后调
  // `adoptDisabledPluginsMirror()` 补收编 —— 也就是说"用户点了开关"到"权威介质落地"
  // 之间隔了一个事件循环 + 一次动态 import + 一次异步落库。
  // 这中间的任何一个环节没走完（进程被杀 / 崩溃 / 端口未就绪），
  // 下一次启动的 `loadDisabledPlugins` 就会拿 DB 的旧值**覆盖镜像**：
  // 用户刚关掉的插件自己又开了，而且**界面上不会有任何提示**。
  //
  // 现在写入方只有一处：`saveDisabledPlugins`（DB 列表 + DB 时间戳 + 镜像 + 镜像时间戳）。
  // 镜像从此是"DB 在某时刻的副本"，不再是第二个真相源；App 侧的收编监听保留着，
  // 作为"还有别的镜像写入方"的兜底（收编时值已相同 → 不做无谓写）。

  private STORAGE_KEY = 'codem:disabled-plugins'

  private loadDisabledList(): string[] | null {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY)
      if (raw === null) return null  // 首次运行
      return JSON.parse(raw)
    } catch { return null }
  }

  /** 写入禁用列表：**DB（权威）+ 镜像**一次写完（第 48 轮 D-22 收口） */
  private persistDisabledList(list: string[]): void {
    persistDisabledPlugins(list)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('codem:plugin-state-changed'))
    }
  }

  /** 显式写入禁用列表（不依赖 states Map） */
  private saveDisabledListExplicit(list: string[]): void {
    this.persistDisabledList(list)
  }

  private saveDisabledList(): void {
    // error 态一并持久化：enable 失败的插件重启后保持"未启用"（可重试），
    // 避免重启后 initialize 误判为 enabled（无 fiber 的假启用状态）
    const disabled = [...this.states.entries()]
      .filter(([, s]) => s.status === 'disabled' || s.status === 'error')
      .map(([n]) => n)
    this.persistDisabledList(disabled)
  }
}

/**
 * 创建全局 PluginManagerService 实例。
 */
let _pluginManager: PluginManagerService | null = null
/** ctx-ready 单例是否已建立（null-ctx 临时实例不缓存） */
let _pluginManagerCtxReady = false

export function getPluginManager(): PluginManagerService {
  if (!_pluginManager || !_pluginManagerCtxReady) {
    throw new Error('PluginManagerService not initialized. Call initPluginManager() first.')
  }
  return _pluginManager
}

/** 仅供测试：重置单例缓存（隔离用例间的 initPluginManager 幂等状态） */
export function resetPluginManagerSingletonForTest(): void {
  _pluginManager = null
  _pluginManagerCtxReady = false
}

/**
 * 初始化全局 PluginManagerService。
 *
 * 幂等语义（修复弹窗每次打开都重建 manager 导致的 fiber 追踪丢失——
 * 旧 manager 加载进 ctx 的插件在新 manager 下无法卸载 → "假禁用"）：
 * - ctx 未就绪（null）：返回**临时**实例（仅渲染用），不写入全局单例；
 * - ctx 就绪：首次创建并缓存 ctx-ready 单例；已存在则直接返回现有实例
 *   （不重复 initialize，已加载插件的 fiber 追踪保持有效，disable 真正卸载）。
 */
export async function initPluginManager(ctx: Context, graph: PluginDependencyGraph): Promise<PluginManagerService> {
  if (!ctx) {
    const temp = new PluginManagerService(null as any, graph)
    await temp.initialize()
    return temp
  }
  if (_pluginManager && _pluginManagerCtxReady) return _pluginManager
  const mgr = new PluginManagerService(ctx, graph)
  await mgr.initialize()
  _pluginManager = mgr
  _pluginManagerCtxReady = true
  return mgr
}

/**
 * ## 禁用结果的**唯一**报账口径（第 63 轮从 `doDisable` 里抽出来的纯函数）
 *
 * 抽出来的直接好处：三种形态都能被单独验证，不必靠"读源码里有没有某个字符串"来防回归
 * （本仓库已有多处那种写法，它挡不住文案被改成别的假话）。
 *
 * 三态，各自只说**证据支持**的话：
 *
 * | 形态 | 判据 | 级别 | 文本要点 |
 * |---|---|---|---|
 * | 卸载成功 | `dispose()` 跑完 | `log` | `unloaded`（正常路径） |
 * | 装载过但没有可卸载句柄 | `everLoaded && !unloaded` | **`warn`** | 真·假禁用：没有句柄，重启才干净 |
 * | 本次进程从未装载 | `!everLoaded && !unloaded` | `log` | 没有卸载对象，禁用已生效、无需重启 |
 *
 * 为什么要分出第三态（真机读数，`.preview-shot/out-pluginmanager-warning.txt`）：
 * ① 冷启动 20s 窗口内**没有**这条日志（它不是启动期无条件打印的）；
 * ② `@codem/ui-game` 在 `codem:disabled-plugins`（localStorage 镜像与 DB 权威**都是**
 *    `["@codem/ui-game"]`）里是禁用的；
 * ③ 整个启动期日志里**没有一行 `Loaded provider: ui-game`** —— `App.tsx:154` 明确
 *    "不调用 `loader.load()`"，`builtinPlugins` 里的 `@codem/ui-game`
 *    （`builtin-registry.ts:520`）本次进程里根本没被装载。
 *
 * 而旧文案写死「该插件的代码/服务仍在本次进程内运行」——
 * 对这类从未装载的插件，那是一句**与读数相反的断言**。
 * 会撒谎的警示比没有警示更糟：它会让人去追一个并不存在的"仍在运行"。
 * 注意：本函数只改**说话的准确性**，不改任何行为 ——
 * "禁用后是否真的卸载"这个能力缺口单独记在下面 KNOWN GAP。
 */
export function reportDisableOutcome(
  name: string,
  state: { unloaded: boolean; everLoaded: boolean },
): void {
  if (state.unloaded) {
    console.log(`[PluginManager] Disabled (unloaded): ${name}`)
  } else if (state.everLoaded) {
    console.warn(
      `[PluginManager] Disabled (状态已置 disabled，但**没有找到可卸载的实例**): ${name}` +
        ` —— 该插件在本次进程里被装载过，但没有可用的卸载句柄，其代码/服务会继续运行到重启为止。`,
    )
  } else {
    console.log(
      `[PluginManager] Disabled (never-loaded): ${name}` +
        ` —— 本次进程内从未装载该插件（没有卸载对象），禁用已生效，无需重启。`,
    )
  }
}

/**
 * ## KNOWN GAP（本轮**未**修，需要单独排期；写在这里是为了下一个人不用重新趟一遍）
 *
 * `doDisable` 只能卸载两种 fiber：`this.fibers`（manager 自己 `ctx.plugin` 的）
 * 与 YAML 装配登记的 `activeFibers`（`yaml-loader.ts`）。
 * 而现有装载路径**不是统一的**：
 *
 * - `yaml-loader.loadFromEntries` / `loadFromYaml` → 登记（`:308` / `:495`）✅
 * - `PluginLoader.load()` → 建了 fiber **但不登记**（`plugin-loader/index.ts:169`）❌
 *   （当前 `App.tsx:154` 明确不调用它，所以这条暂时不暴露）
 * - `ui-plugins/index.ts:94/140` 的 `ctx.plugin(...)` → 不登记 ❌
 *
 * 也就是说：**一旦某条路径真把这些插装载起来**（例如将来恢复 `loader.load()`，
 * 或把 `builtinPlugins` 接进某个装载器），用户点"关闭"就会走进 `everLoaded=true`
 * 那一条：状态改了、fiber 却找不到，插件会一直跑到重启 —— 那才是这条 warn 真正该报的形态。
 * 根治办法是把三条路径统一登记（`registerActiveFiber`），
 * 但那会改动启动装配链（207 个插件），不在本轮"技能市场/插件面板 console"的范围内。
 */

