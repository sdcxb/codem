// @ts-nocheck
/**
 * Codem Plugin Loader — 插件加载器。
 *
 * 扫描 package.json 中的 `codem` 字段，按依赖拓扑排序加载插件包。
 * 支持的 codem 字段：
 * - inject: 依赖的 ctx keys（Service Definition）
 * - provides: 提供的 ctx keys（Provider 角色）
 * - slots: 注册到的 UI 槽位
 * - platform: 平台限制
 * - hot: 是否支持热重载
 * - optional: 是否可选
 * - priority: 同一 ctx key 的优先级
 */

import type { Context, Plugin } from '../cordis/src/index.ts'

/** 插件元数据（来自 package.json 的 codem 字段）。 */
export interface PluginMeta {
  /** 依赖的 ctx keys（Service Definition）。 */
  inject?: string[]
  /** 提供的 ctx keys（Provider 角色）。 */
  provides?: string[]
  /** 注册到的 UI 槽位。 */
  slots?: string[]
  /** 平台限制。 */
  platform?: string[]
  /** 是否支持热重载。 */
  hot?: boolean
  /** 是否可选（缺失不报错）。 */
  optional?: boolean
  /** 同一 ctx key 的优先级（多 Provider 竞争）。 */
  priority?: number
}

/** 已加载的插件记录。 */
export interface LoadedPlugin {
  name: string
  meta: PluginMeta
  plugin: Plugin
  fiber: any
}

/**
 * 插件加载器 — 扫描、排序、加载插件包。
 *
 * Cordis 的 inject 机制自动处理依赖等待：
 * - 如果插件 A 声明 inject: ['fs']，但 fs 的 Provider 尚未加载，
 *   Cordis 会将 A 保持为 PENDING 状态，直到 fs Provider 就绪。
 * - 这意味着 P4 创建的 Consumer 包可以在 P5 加载 Provider 后自动激活。
 */
export class PluginLoader {
  /** 已发现的插件包（按扫描顺序）。 */
  private discovered: Map<string, { name: string; meta: PluginMeta; apply: Plugin }> = new Map()
  /** 已加载的插件。 */
  private loaded: Map<string, LoadedPlugin> = new Map()

  constructor(private ctx: Context) {}

  /**
   * 手动注册一个插件包（用于非 package.json 场景或测试）。
   *
   * @param name — 插件包名
   * @param meta — 插件元数据
   * @param apply — 插件入口函数
   */
  add(name: string, meta: PluginMeta, apply: Plugin) {
    this.discovered.set(name, { name, meta, apply })
  }

  /**
   * 扫描已注册的插件包。
   * 在 monorepo 中，可以扫描 node_modules/@codem/ 下的包。
   * 在单包中，扫描已 add() 的包。
   */
  async scan() {
    // 在实际实现中，这里会扫描 node_modules/@codem/ 目录
    // 或读取 codem.yml 配置文件
    // 目前仅处理手动 add() 的插件
  }

  /**
   * 按依赖拓扑排序加载所有已发现的插件。
   *
   * Cordis 的 inject 机制会自动处理运行时依赖等待，
   * 但拓扑排序确保声明的依赖在 Provider 之前/之后加载。
   */
  async load() {
    // 拓扑排序：按照 provides -> inject 依赖关系排序
    const sorted = this.topologicalSort()

    for (const { name, meta, apply } of sorted) {
      try {
        const fiber = this.ctx.plugin({
          ...apply,
          name: name,
          inject: meta.inject,
        })
        this.loaded.set(name, { name, meta, plugin: apply, fiber })
        this.ctx.logger('plugin-loader').info(`Loaded plugin: ${name}`)
      } catch (err) {
        if (meta.optional) {
          this.ctx.logger('plugin-loader').warn(`Optional plugin failed to load: ${name}`, err)
        } else {
          this.ctx.logger('plugin-loader').error(`Failed to load plugin: ${name}`, err)
          throw err
        }
      }
    }
  }

  /**
   * 拓扑排序：确保 provides 的包在 inject 它的包之前加载。
   */
  private topologicalSort(): { name: string; meta: PluginMeta; apply: Plugin }[] {
    const nodes = [...this.discovered.values()]
    const sorted: { name: string; meta: PluginMeta; apply: Plugin }[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (name: string) => {
      if (visited.has(name)) return
      if (visiting.has(name)) {
        this.ctx.logger('plugin-loader').warn(`Circular dependency detected involving: ${name}`)
        return
      }
      visiting.add(name)

      const node = this.discovered.get(name)
      if (!node) return

      // 找到这个包提供的所有服务
      const provides = new Set(node.meta.provides ?? [])

      // 找到所有依赖这些服务但尚未排序的包
      for (const [depName, depNode] of this.discovered) {
        if (visited.has(depName) || visiting.has(depName)) continue
        const injects = depNode.meta.inject ?? []
        if (injects.some((inj) => provides.has(inj))) {
          visit(depName)
        }
      }

      visiting.delete(name)
      visited.add(name)
      sorted.push(node)
    }

    for (const node of nodes) {
      visit(node.name)
    }

    return sorted
  }

  /**
   * 卸载一个已加载的插件。
   */
  async unload(name: string) {
    const loaded = this.loaded.get(name)
    if (!loaded) return
    await loaded.fiber.dispose()
    this.loaded.delete(name)
    this.ctx.logger('plugin-loader').info(`Unloaded plugin: ${name}`)
  }

  /**
   * 重新加载一个插件（热重载）。
   */
  async reload(name: string) {
    await this.unload(name)
    const node = this.discovered.get(name)
    if (!node) return
    const fiber = this.ctx.plugin({
      ...node.apply,
      name: name,
      inject: node.meta.inject,
    })
    this.loaded.set(name, { name, meta: node.meta, plugin: node.apply, fiber })
    this.ctx.logger('plugin-loader').info(`Reloaded plugin: ${name}`)
  }

  /** 获取所有已加载的插件。 */
  getLoadedPlugins(): LoadedPlugin[] {
    return [...this.loaded.values()]
  }

  /** 检查一个插件是否已加载。 */
  isLoaded(name: string): boolean {
    return this.loaded.has(name)
  }
}
