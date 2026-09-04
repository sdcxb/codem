// @ts-nocheck
/**
 * PluginManagerService — 插件开关管理服务。
 *
 * 管理插件的启用/禁用状态，处理依赖关系，与 Cordis Context 联动。
 *
 * 核心功能：
 * 1. 维护插件启用/禁用状态（持久化到 localStorage）
 * 2. 关闭插件时检查依赖，返回级联关闭列表
 * 3. 启用插件时检查依赖，自动启用缺失的依赖
 * 4. 与 Cordis Context 联动（实际加载/卸载 Provider）
 */

import { PluginDependencyGraph, type PluginMeta, type CascadeDisableResult, type CascadeEnableResult } from './dependency-graph'
import type { Context } from '../cordis/src/index.ts'
import { builtinPlugins } from './index'
import { getActiveFiber, unregisterActiveFiber } from './yaml-loader'

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

    // 从 localStorage 恢复禁用列表
    let disabledList = this.loadDisabledList()

    // 首次运行：localStorage 无记录时，使用默认禁用列表
    if (disabledList === null) {
      disabledList = [...this.DEFAULT_DISABLED]
      this.saveDisabledListExplicit(disabledList)
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
    for (const pluginName of cascade.toDisable) {
      await this.doDisable(pluginName)
      disabledList.push(pluginName)
    }

    this.saveDisabledList()
    this.notifyListeners()
    return { success: true, disabledList, needsConfirmation: cascade.needsConfirmation }
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
  private async doDisable(name: string): Promise<void> {
    const fiber = this.fibers.get(name)
    if (fiber?.dispose) {
      try {
        await fiber.dispose()
      } catch (err) {
        console.warn(`[PluginManager] Error disposing ${name}:`, err)
      }
    }
    this.fibers.delete(name)

    const activeFiber = getActiveFiber(name)
    if (activeFiber?.dispose) {
      try {
        await activeFiber.dispose()
      } catch (err) {
        console.warn(`[PluginManager] Error disposing (assembled) ${name}:`, err)
      }
    }
    unregisterActiveFiber(name)

    this.states.set(name, { name, status: 'disabled', updatedAt: Date.now() })
    console.log(`[PluginManager] Disabled (unloaded): ${name}`)
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

  // ===== localStorage 持久化 =====

  private STORAGE_KEY = 'codem:disabled-plugins'

  private loadDisabledList(): string[] | null {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY)
      if (raw === null) return null  // 首次运行
      return JSON.parse(raw)
    } catch { return null }
  }

  /** 显式写入禁用列表到 localStorage（不依赖 states Map） */
  private saveDisabledListExplicit(list: string[]): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list))
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('codem:plugin-state-changed'))
      }
    } catch {}
  }

  private saveDisabledList(): void {
    // error 态一并持久化：enable 失败的插件重启后保持"未启用"（可重试），
    // 避免重启后 initialize 误判为 enabled（无 fiber 的假启用状态）
    const disabled = [...this.states.entries()]
      .filter(([, s]) => s.status === 'disabled' || s.status === 'error')
      .map(([n]) => n)
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(disabled))
    // 通知 App 层刷新插件按钮状态
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('codem:plugin-state-changed'))
    }
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
