// @ts-nocheck
/**
 * PluginDependencyGraph — 插件依赖图引擎。
 *
 * 核心功能：
 * 1. 维护插件元数据（provides/inject 关系）
 * 2. 计算插件的依赖链（A 依赖 B，B 依赖 C...）
 * 3. 计算插件的被依赖链（B 被 A 依赖）
 * 4. 当关闭某插件时，计算级联关闭列表
 * 5. 当启用某插件时，计算需要先启用的依赖列表
 *
 * 依赖模型：
 * - 插件 A 的 inject: ['llm', 'fs'] 表示 A 依赖 llm 和 fs 服务
 * - 插件 B 的 provides: ['llm'] 表示 B 提供 llm 服务
 * - 如果 A inject 'llm' 且 B provides 'llm'，则 A 依赖 B
 */

export interface PluginMeta {
  name: string
  version?: string
  description?: string
  provides?: string[]
  inject?: string[]
  slots?: string[]
  keywords?: string[]
  optional?: boolean
  priority?: number
  hot?: boolean
  category?: 'core' | 'provider' | 'ui' | 'tool' | 'compat'
  /** 插件类型标签（用于 UI 展示） */
  tags?: PluginTag[]
  /** 是否为核心系统插件（不可关闭） */
  core?: boolean
  /** 是否锁定（不可关闭，如框架级服务） */
  locked?: boolean
  /** 作者 */
  author?: string
  /** 主页 URL */
  homepage?: string
  /** 图标（emoji 或 icon name） */
  icon?: string
  /** 风险等级：关闭后影响的严重程度 */
  riskLevel?: 'safe' | 'caution' | 'danger'
  /** 风险描述：关闭后会导致什么功能不可用 */
  riskDescription?: string
  /** UI 影响声明：关闭此插件会影响哪些 UI 元素 */
  uiImpact?: {
    /** 影响的 Slot 名称（如 'app.sidebar', 'app.conversation'） */
    slots?: string[]
    /** 影响的按钮（如 'cicd', 'perf', 'plugin-manager'） */
    buttons?: string[]
    /** 影响的面板（如 'settings', 'terminal'） */
    panels?: string[]
    /** UI 降级说明：关闭后 UI 会如何变化 */
    degradedTo?: string
  }
}

/** 风险等级说明 */
export const RISK_LEVEL_CONFIG = {
  /** safe: 关闭后无影响或仅有替代方案 */
  safe: { label: '安全', color: 'var(--success)', icon: '✅' },
  /** caution: 关闭后部分功能受限，但不影响核心流程 */
  caution: { label: '需注意', color: 'var(--warning)', icon: '⚠️' },
  /** danger: 关闭后核心功能不可用（如 Agent 无法推理/执行） */
  danger: { label: '高风险', color: 'var(--error)', icon: '🔴' },
} as const

/** 插件类型标签 */
export type PluginTag =
  | 'service'      // 服务定义（Service Definition）
  | 'provider'     // 服务实现（Provider）
  | 'ui'           // UI 组件
  | 'tool'         // 工具
  | 'bridge'       // 桥接/适配
  | 'infra'        // 基础设施
  | 'agent'        // 代理能力
  | 'storage'      // 存储
  | 'runtime'      // 运行时
  | 'security'     // 安全/权限

export interface PluginDependencyInfo {
  /** 此插件依赖哪些插件（通过 inject → provides 匹配） */
  dependencies: string[]
  /** 哪些插件依赖此插件（通过 provides → inject 匹配） */
  dependents: string[]
  /** 此插件提供哪些服务 */
  provides: string[]
  /** 此插件消费哪些服务 */
  inject: string[]
  /** 依赖描述（人类可读） */
  dependencyDescription: string
  /** P2-3: UI 依赖 — 此插件关闭后哪些 UI 元素受影响（来自 uiImpact） */
  uiDepends?: {
    slots: string[]
    buttons: string[]
    panels: string[]
    degradedTo?: string
  }
  /** P2-3: 此插件被哪些 UI 插件依赖（反向：UI 插件 inject 了此插件 provides 的服务） */
  uiAffectedBy?: string[]
}

export interface CascadeDisableResult {
  /** 要关闭的插件列表（包含目标插件和所有级联依赖它的插件） */
  toDisable: string[]
  /** 被影响的插件详情 */
  affected: Array<{ name: string; reason: string }>
  /** 是否需要用户确认 */
  needsConfirmation: boolean
  /** 是否因核心锁定而拒绝关闭 */
  lockedReason?: string
}

export interface CascadeEnableResult {
  /** 要启用的插件列表（包含目标插件和所有需要先启用的依赖） */
  toEnable: string[]
  /** 缺失的依赖（未安装的插件） */
  missingDependencies: string[]
  /** 是否可以启用 */
  canEnable: boolean
}

/**
 * 插件依赖图引擎。
 *
 * 使用方式：
 * ```typescript
 * const graph = new PluginDependencyGraph()
 * graph.register({ name: '@codem/llm', provides: ['llm'], inject: [] })
 * graph.register({ name: '@codem/tool-fs', provides: [], inject: ['fs'] })
 * graph.register({ name: '@codem/fs-local', provides: ['fs'], inject: [] })
 *
 * // 查询依赖关系
 * graph.getDependencyInfo('@codem/tool-fs')
 * // → { dependencies: ['@codem/fs-local'], dependents: [], ... }
 *
 * // 计算级联关闭
 * graph.getCascadeDisable('@codem/fs-local')
 * // → { toDisable: ['@codem/fs-local', '@codem/tool-fs'], needsConfirmation: true }
 * ```
 */
export class PluginDependencyGraph {
  private plugins = new Map<string, PluginMeta>()
  /** service name → 提供此服务的插件列表 */
  private providers = new Map<string, string[]>()
  /** 插件名 → 依赖的插件列表（缓存） */
  private dependencyCache = new Map<string, string[]>()
  /** 插件名 → 被依赖的插件列表（缓存） */
  private dependentCache = new Map<string, string[]>()

  /** 注册一个插件到依赖图 */
  register(meta: PluginMeta): void {
    this.plugins.set(meta.name, meta)
    // 更新 providers 映射
    for (const svc of meta.provides ?? []) {
      if (!this.providers.has(svc)) {
        this.providers.set(svc, [])
      }
      this.providers.get(svc)!.push(meta.name)
    }
    // 清除缓存
    this.dependencyCache.clear()
    this.dependentCache.clear()
  }

  /** 注销一个插件 */
  unregister(name: string): void {
    const meta = this.plugins.get(name)
    if (!meta) return
    this.plugins.delete(name)
    // 从 providers 映射中移除
    for (const svc of meta.provides ?? []) {
      const list = this.providers.get(svc)
      if (list) {
        const idx = list.indexOf(name)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) this.providers.delete(svc)
      }
    }
    this.dependencyCache.clear()
    this.dependentCache.clear()
  }

  /** 获取所有已注册插件 */
  list(): PluginMeta[] {
    return [...this.plugins.values()]
  }

  /** 获取一个插件的元数据 */
  get(name: string): PluginMeta | undefined {
    return this.plugins.get(name)
  }

  /**
   * 计算插件的直接依赖（A inject 的服务由哪些插件 provides）。
   */
  getDirectDependencies(name: string): string[] {
    if (this.dependencyCache.has(name)) {
      return this.dependencyCache.get(name)!
    }

    const meta = this.plugins.get(name)
    if (!meta) return []

    const deps = new Set<string>()
    for (const svc of meta.inject ?? []) {
      // 找到提供此服务的插件
      const providers = this.providers.get(svc) || []
      for (const p of providers) {
        if (p !== name) deps.add(p)
      }
    }

    const result = [...deps]
    this.dependencyCache.set(name, result)
    return result
  }

  /**
   * 计算插件的直接被依赖（哪些插件 inject 了此插件 provides 的服务）。
   */
  getDirectDependents(name: string): string[] {
    if ( this.dependentCache.has(name)) {
      return this.dependentCache.get(name)!
    }

    const meta = this.plugins.get(name)
    if (!meta) return []

    const dependents = new Set<string>()
    for (const svc of meta.provides ?? []) {
      // 找到所有 inject 此服务的插件
      for (const [pluginName, pluginMeta] of this.plugins) {
        if (pluginName === name) continue
        if (pluginMeta.inject?.includes(svc)) {
          dependents.add(pluginName)
        }
      }
    }

    const result = [...dependents]
    this.dependentCache.set(name, result)
    return result
  }

  /**
   * 获取完整的依赖信息（含人类可读描述和 UI 影响）。
   */
  getDependencyInfo(name: string): PluginDependencyInfo {
    const meta = this.plugins.get(name)
    if (!meta) {
      return {
        dependencies: [],
        dependents: [],
        provides: [],
        inject: [],
        dependencyDescription: 'Plugin not found',
      }
    }

    const dependencies = this.getDirectDependencies(name)
    const dependents = this.getDirectDependents(name)

    // 生成人类可读的依赖描述
    let desc = ''
    if (dependencies.length > 0) {
      desc += `依赖: ${dependencies.join(', ')}`
    }
    if (dependents.length > 0) {
      if (desc) desc += '；'
      desc += `被依赖: ${dependents.join(', ')}`
    }

    // P2-3: 计算 UI 依赖 — 从 uiImpact 提取
    let uiDepends: PluginDependencyInfo['uiDepends'] | undefined
    if (meta.uiImpact) {
      uiDepends = {
        slots: meta.uiImpact.slots ?? [],
        buttons: meta.uiImpact.buttons ?? [],
        panels: meta.uiImpact.panels ?? [],
        degradedTo: meta.uiImpact.degradedTo,
      }
      if (uiDepends.slots.length > 0 || uiDepends.buttons.length > 0 || uiDepends.panels.length > 0) {
        if (desc) desc += '；'
        const parts: string[] = []
        if (uiDepends.slots.length > 0) parts.push(`UI 槽位: ${uiDepends.slots.join(', ')}`)
        if (uiDepends.buttons.length > 0) parts.push(`按钮: ${uiDepends.buttons.join(', ')}`)
        if (uiDepends.panels.length > 0) parts.push(`面板: ${uiDepends.panels.join(', ')}`)
        desc += `UI 影响: ${parts.join(', ')}`
        if (uiDepends.degradedTo) desc += `（降级为: ${uiDepends.degradedTo}）`
      }
    }

    // P2-3: 计算 UI 反向依赖 — 哪些 UI 插件 inject 了此插件 provides 的服务
    const uiAffectedBy: string[] = []
    for (const svc of meta.provides ?? []) {
      for (const [pluginName, pluginMeta] of this.plugins) {
        if (pluginName === name) continue
        if (pluginMeta.inject?.includes(svc) && pluginMeta.tags?.includes('ui')) {
          uiAffectedBy.push(pluginName)
        }
      }
    }

    if (!desc) desc = '无依赖关系'

    return {
      dependencies,
      dependents,
      provides: meta.provides ?? [],
      inject: meta.inject ?? [],
      dependencyDescription: desc,
      uiDepends,
      uiAffectedBy: uiAffectedBy.length > 0 ? [...new Set(uiAffectedBy)] : undefined,
    }
  }

  /**
   * 计算级联关闭：关闭目标插件会级联关闭哪些依赖它的插件。
   *
   * 例如：关闭 @codem/fs-local（provides: ['fs']）
   * → @codem/tool-fs（inject: ['fs']）依赖它，也需要关闭
   * → 如果 @codem/tool-fs 也被其他插件依赖，继续级联
   */
  getCascadeDisable(name: string): CascadeDisableResult {
    // 检查是否为核心锁定插件
    const meta = this.plugins.get(name)
    if (meta?.locked || meta?.core) {
      return {
        toDisable: [],
        affected: [],
        needsConfirmation: false,
        lockedReason: meta.core
          ? `"${name}" 是核心系统插件，关闭将导致系统崩溃，无法关闭。`
          : `"${name}" 已被锁定，无法关闭。`,
      }
    }

    const toDisable = new Set<string>()
    const affected: Array<{ name: string; reason: string }> = []

    const collectDependents = (pluginName: string, reason: string) => {
      if (toDisable.has(pluginName)) return

      // 检查级联中是否有核心插件
      const depMeta = this.plugins.get(pluginName)
      if (depMeta?.locked || depMeta?.core) {
        // 核心插件不能被级联关闭
        return
      }

      toDisable.add(pluginName)
      affected.push({ name: pluginName, reason })

      // 找到所有依赖此插件的插件
      const dependents = this.getDirectDependents(pluginName)
      for (const dep of dependents) {
        if (!toDisable.has(dep)) {
          collectDependents(dep, `依赖 ${pluginName} 提供的服务`)
        }
      }
    }

    collectDependents(name, '用户主动关闭')

    // P2-3: 在 affected 列表中追加 UI 降级提示
    for (const item of affected) {
      const itemMeta = this.plugins.get(item.name)
      if (itemMeta?.uiImpact) {
        const uiParts: string[] = []
        if (itemMeta.uiImpact.slots?.length) uiParts.push(`槽位: ${itemMeta.uiImpact.slots.join(', ')}`)
        if (itemMeta.uiImpact.buttons?.length) uiParts.push(`按钮: ${itemMeta.uiImpact.buttons.join(', ')}`)
        if (itemMeta.uiImpact.panels?.length) uiParts.push(`面板: ${itemMeta.uiImpact.panels.join(', ')}`)
        if (uiParts.length > 0) {
          item.reason += `；UI 影响: ${uiParts.join(', ')}`
          if (itemMeta.uiImpact.degradedTo) {
            item.reason += `（降级为: ${itemMeta.uiImpact.degradedTo}）`
          }
        }
      }
    }

    return {
      toDisable: [...toDisable],
      affected,
      needsConfirmation: affected.length > 1 || affected.some(a => {
        const m = this.plugins.get(a.name)
        return m?.uiImpact && (
          (m.uiImpact.slots?.length ?? 0) > 0 ||
          (m.uiImpact.buttons?.length ?? 0) > 0 ||
          (m.uiImpact.panels?.length ?? 0) > 0
        )
      }),
    }
  }

  /**
   * 计算级联启用：启用目标插件需要先启用哪些依赖。
   *
   * 例如：启用 @codem/tool-fs（inject: ['fs']）
   * → 需要先启用 @codem/fs-local（provides: ['fs']）
   * → 如果 @codem/fs-local 也有依赖，继续递归
   */
  getCascadeEnable(name: string, currentlyEnabled: Set<string>): CascadeEnableResult {
    const toEnable = new Set<string>()
    const missing = new Set<string>()

    const collectDependencies = (pluginName: string) => {
      if (toEnable.has(pluginName)) return
      if (currentlyEnabled.has(pluginName)) return

      const meta = this.plugins.get(pluginName)
      if (!meta) {
        missing.add(pluginName)
        return
      }

      toEnable.add(pluginName)

      // 递归收集依赖
      const deps = this.getDirectDependencies(pluginName)
      for (const dep of deps) {
        collectDependencies(dep)
      }
    }

    collectDependencies(name)

    return {
      toEnable: [...toEnable].reverse(), // 依赖在前，目标在后
      missingDependencies: [...missing],
      canEnable: missing.size === 0,
    }
  }

  /**
   * 检查插件是否可以安全关闭（没有其他插件依赖它）。
   */
  canSafelyDisable(name: string): boolean {
    const meta = this.plugins.get(name)
    if (meta?.locked || meta?.core) return false
    return this.getDirectDependents(name).length === 0
  }

  /**
   * 获取插件的服务依赖链（用于显示）。
   *
   * 例如：@codem/tool-fs → inject: ['fs'] → @codem/fs-local provides: ['fs']
   */
  getServiceChain(name: string): Array<{
    service: string
    providedBy: string | null
  }> {
    const meta = this.plugins.get(name)
    if (!meta) return []

    return (meta.inject ?? []).map(svc => {
      const providers = this.providers.get(svc) || []
      return {
        service: svc,
        providedBy: providers.length > 0 ? providers[0] : null,
      }
    })
  }
}
