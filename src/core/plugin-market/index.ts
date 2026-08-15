// @ts-nocheck
/**
 * @codem/plugin-registry — 插件注册中心
 *
 * 插件元数据存储 + 搜索。
 */
import type { Context, Plugin } from '../cordis/src/index.ts'

export interface PluginMetadata {
  name: string
  version: string
  description: string
  author?: string
  provides: string[]
  inject: string[]
  slots?: string[]
  platform?: string[]
  homepage?: string
  repository?: string
  keywords?: string[]
}

export interface PluginRegistryService {
  register(meta: PluginMetadata): void
  unregister(name: string): void
  get(name: string): PluginMetadata | undefined
  search(query: string, limit?: number): PluginMetadata[]
  list(): PluginMetadata[]
  listByCapability(capability: string): PluginMetadata[]
}

export class InMemoryPluginRegistry implements PluginRegistryService {
  private plugins = new Map<string, PluginMetadata>()

  register(meta: PluginMetadata): void {
    this.plugins.set(meta.name, meta)
    console.log(`[PluginRegistry] Registered: ${meta.name}@${meta.version}`)
  }

  unregister(name: string): void {
    this.plugins.delete(name)
  }

  get(name: string): PluginMetadata | undefined {
    return this.plugins.get(name)
  }

  search(query: string, limit: number = 20): PluginMetadata[] {
    const q = query.toLowerCase()
    return [...this.plugins.values()]
      .filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.keywords?.some(k => k.toLowerCase().includes(q))
      )
      .slice(0, limit)
  }

  list(): PluginMetadata[] {
    return [...this.plugins.values()]
  }

  listByCapability(capability: string): PluginMetadata[] {
    return [...this.plugins.values()].filter(p =>
      p.provides.includes(capability) || p.inject.includes(capability)
    )
  }
}

declare module '../cordis/src/context.ts' {
  interface Context {
    pluginRegistry: PluginRegistryService
    pluginInstaller: PluginInstallerService
  }
}

// ========== 插件安装器 ==========

export interface PluginInstallerService {
  install(name: string, source?: 'npm' | 'git' | 'url'): Promise<{ success: boolean; error?: string }>
  uninstall(name: string): Promise<{ success: boolean; error?: string }>
  update(name: string): Promise<{ success: boolean; error?: string }>
  isInstalled(name: string): boolean
}

export class LocalPluginInstaller implements PluginInstallerService {
  private installed = new Set<string>()

  constructor(private registry: PluginRegistryService) {}

  async install(name: string, source?: 'npm' | 'git' | 'url'): Promise<{ success: boolean; error?: string }> {
    try {
      const meta = this.registry.get(name)
      if (!meta) {
        return { success: false, error: `Plugin "${name}" not found in registry` }
      }

      // 模拟安装过程
      console.log(`[PluginInstaller] Installing ${name} from ${source || 'npm'}...`)
      this.installed.add(name)
      console.log(`[PluginInstaller] Installed: ${name}`)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.installed.has(name)) {
      return { success: false, error: `Plugin "${name}" not installed` }
    }
    this.installed.delete(name)
    console.log(`[PluginInstaller] Uninstalled: ${name}`)
    return { success: true }
  }

  async update(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.installed.has(name)) {
      return { success: false, error: `Plugin "${name}" not installed` }
    }
    console.log(`[PluginInstaller] Updated: ${name}`)
    return { success: true }
  }

  isInstalled(name: string): boolean {
    return this.installed.has(name)
  }
}

// ========== 插件定义 ==========

export const inject = [] as const
export const provide = ['pluginRegistry', 'pluginInstaller'] as const

export const apply: Plugin = (ctx: Context) => {
  const registry = new InMemoryPluginRegistry()
  ctx.provide('pluginRegistry', registry)
  ctx.provide('pluginInstaller', new LocalPluginInstaller(registry))

  // 注册已知插件元数据
  const knownPlugins: PluginMetadata[] = [
    { name: '@codem/llm', version: '1.0.0', description: 'LLM Service Definition', provides: ['llm'], inject: [], keywords: ['llm', 'ai', 'model'] },
    { name: '@codem/llm-deepseek', version: '1.0.0', description: 'DeepSeek LLM Provider', provides: ['llm'], inject: [], keywords: ['llm', 'deepseek'] },
    { name: '@codem/fs', version: '1.0.0', description: 'FileSystem Service Definition', provides: ['fs'], inject: [], keywords: ['fs', 'file', 'io'] },
    { name: '@codem/fs-local', version: '1.0.0', description: 'Local FileSystem Provider', provides: ['fs'], inject: [], keywords: ['fs', 'local'] },
    { name: '@codem/shell', version: '1.0.0', description: 'Shell Service Definition', provides: ['shell'], inject: [], keywords: ['shell', 'bash'] },
    { name: '@codem/shell-local', version: '1.0.0', description: 'Local Shell Provider', provides: ['shell'], inject: [], keywords: ['shell', 'local'] },
    { name: '@codem/web', version: '1.0.0', description: 'Web Service Definition', provides: ['web'], inject: [], keywords: ['web', 'search'] },
    { name: '@codem/tool-fs', version: '1.0.0', description: 'File tools (read/write/glob/grep)', provides: [], inject: ['fs', 'tools'], keywords: ['tool', 'file'] },
    { name: '@codem/tool-bash', version: '1.0.0', description: 'Bash tool', provides: [], inject: ['shell', 'tools'], keywords: ['tool', 'bash'] },
    { name: '@codem/tool-web', version: '1.0.0', description: 'Web tools (search/fetch)', provides: [], inject: ['web', 'tools'], keywords: ['tool', 'web'] },
    { name: '@codem/extensions', version: '1.0.0', description: 'Self-Referential Runtime', provides: ['dynamicCordisRunner'], inject: [], keywords: ['runtime', 'dynamic'] },
    { name: '@codem/tool-cordis', version: '1.0.0', description: 'Cordis management tools', provides: [], inject: ['dynamicCordisRunner', 'tools'], keywords: ['tool', 'cordis'] },
  ]

  for (const meta of knownPlugins) {
    registry.register(meta)
  }
}
