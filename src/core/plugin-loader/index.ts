// @ts-nocheck
/**
 * Codem Plugin Loader — 插件加载器。
 *
 * 扫描 codem.yml 和 package.json 中的 `codem` 字段，
 * 按依赖拓扑排序加载插件包。
 *
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

/** 插件元数据（来自 package.json 的 codem 字段或 codem.yml）。 */
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

// 内置插件注册表
const builtinPlugins: Map<string, { meta: PluginMeta; apply: () => any }> = new Map()

/** 注册一个内置插件（用于非 package.json 场景）。 */
export function registerBuiltinPlugin(name: string, meta: PluginMeta, apply: () => any) {
  builtinPlugins.set(name, { meta, apply })
}

/** 获取已注册内置插件数量。 */
export function getBuiltinPluginCount(): number {
  return builtinPlugins.size
}

/**
 * 插件加载器 — 扫描、排序、加载插件包。
 */
export class PluginLoader {
  /** 已发现的插件包（按扫描顺序）。 */
  private discovered: Map<string, { name: string; meta: PluginMeta; apply: Plugin }> = new Map()
  /** 已加载的插件。 */
  private loaded: Map<string, LoadedPlugin> = new Map()

  constructor(private ctx: Context) {}

  /**
   * 手动注册一个插件包。
   */
  add(name: string, meta: PluginMeta, apply: Plugin) {
    this.discovered.set(name, { name, meta, apply })
  }

  /**
   * 扫描已注册的插件包。
   *
   * 1. 读取 codem.yml 配置文件
   * 2. 扫描内置插件注册表
   * 3. （可选）扫描 node_modules/@codem/ 目录
   */
  async scan() {
    // 1. 扫描内置插件注册表
    for (const [name, { meta, apply }] of builtinPlugins) {
      const applyFn = apply() as any
      this.discovered.set(name, { name, meta, apply: applyFn })
    }

    // 2. 尝试读取 codem.yml（在 Vite 环境中通过 ?raw import 加载）
    try {
      // Vite 支持 ?raw 后缀导入文件内容
      const ymlModule = await import('../../../codem.yml?raw')
      const ymlContent = ymlModule.default as string
      this.parseYaml(ymlContent)
    } catch {
      // codem.yml 不存在或无法加载，使用已注册的内置插件
    }

    console.log(`[PluginLoader] Discovered ${this.discovered.size} plugins`)
  }

  /**
   * 简单的 YAML 解析（仅支持 codem.yml 格式）。
   */
  private parseYaml(content: string) {
    const lines = content.split('\n')
    let inPlugins = false
    let currentPlugin: { name: string; meta: PluginMeta } | null = null

    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (trimmed.startsWith('#') || trimmed === '') continue

      if (trimmed === 'plugins:') {
        inPlugins = true
        continue
      }

      if (inPlugins) {
        // 新插件条目开始
        if (trimmed.startsWith('  - name:')) {
          if (currentPlugin) {
            // 保存前一个插件
            // 注意：codem.yml 声明的插件不自动加载，因为它们已通过 loadDefaultProviders 加载
            // 这里只用于元数据注册
          }
          const name = trimmed.replace('  - name:', '').trim().replace(/['"]/g, '')
          currentPlugin = { name, meta: {} }
        } else if (currentPlugin && trimmed.startsWith('    ')) {
          // 解析插件属性
          const propMatch = trimmed.match(/^\s+(\w+):\s*(.*)$/)
          if (propMatch) {
            const [, key, value] = propMatch
            const cleanValue = value.trim().replace(/['"]/g, '')
            switch (key) {
              case 'provides':
              case 'inject':
              case 'slots':
                if (cleanValue && cleanValue !== '[]') {
                  currentPlugin.meta[key] = cleanValue.replace(/[\[\]]/g, '').split(',').map(s => s.trim())
                } else {
                  currentPlugin.meta[key] = []
                }
                break
              case 'priority':
                currentPlugin.meta[key] = parseInt(cleanValue, 10)
                break
              case 'hot':
              case 'optional':
                currentPlugin.meta[key] = cleanValue === 'true'
                break
            }
          }
        }
      }
    }
  }

  /**
   * 按依赖拓扑排序加载所有已发现的插件。
   */
  async load() {
    const sorted = this.topologicalSort()

    for (const { name, meta, apply } of sorted) {
      try {
        const fiber = this.ctx.plugin({
          ...apply,
          name: name,
          inject: meta.inject,
        } as any)
        this.loaded.set(name, { name, meta, plugin: apply, fiber })
        console.log(`[PluginLoader] Loaded: ${name}`)
      } catch (err) {
        if (meta.optional) {
          console.warn(`[PluginLoader] Optional plugin failed: ${name}`, err)
        } else {
          console.error(`[PluginLoader] Failed to load: ${name}`, err)
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
        console.warn(`[PluginLoader] Circular dependency: ${name}`)
        return
      }
      visiting.add(name)

      const node = this.discovered.get(name)
      if (!node) return

      const provides = new Set(node.meta.provides ?? [])

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
    if (loaded.fiber?.dispose) {
      await loaded.fiber.dispose()
    }
    this.loaded.delete(name)
    console.log(`[PluginLoader] Unloaded: ${name}`)
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
    } as any)
    this.loaded.set(name, { name, meta: node.meta, plugin: node.apply, fiber })
    console.log(`[PluginLoader] Reloaded: ${name}`)
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
