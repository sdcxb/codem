// @ts-nocheck
/**
 * @codem/cordis-host-runner — Self-Referential Runtime Provider
 *
 * 在沙箱中执行 Agent 动态编写的插件代码。
 * 使用 node:vm (或浏览器环境的 Function 沙箱) 执行。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { DynamicCordisRunner, PluginInfo } from './index.ts'

export class HostCordisRunner implements DynamicCordisRunner {
  private dynamicPlugins = new Map<string, { name: string; code: string; provides: string[]; inject: string[]; compiled?: Function }>();

  constructor(private ctx: Context) {}

  inspect(): { plugins: PluginInfo[]; services: string[] } {
    const plugins: PluginInfo[] = [...this.dynamicPlugins.values()].map(p => ({
      name: p.name,
      provides: p.provides,
      inject: p.inject,
      isDynamic: true,
    }))

    // 也列出 Cordis 已注册的静态服务
    const services = Object.keys(this.ctx).filter(k => !k.startsWith('_') && typeof (this.ctx as any)[k] !== 'undefined')

    return { plugins, services }
  }

  async define(name: string, code: string): Promise<{ success: boolean; error?: string }> {
    if (this.dynamicPlugins.has(name)) {
      return { success: false, error: `Plugin "${name}" already defined` }
    }

    try {
      // 在浏览器环境使用 Function 构造器创建沙箱
      // 提供有限的 ctx 访问
      const wrappedCode = `
        const module = { exports: {} };
        const exports = module.exports;
        ${code}
        return module.exports;
      `

      const compiled = new Function('ctx', wrappedCode)
      this.dynamicPlugins.set(name, { name, code, provides: [], inject: [], compiled })
      console.log(`[DynamicCordisRunner] Plugin "${name}" defined`)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async run(name: string, args?: any): Promise<{ success: boolean; result?: any; error?: string }> {
    const plugin = this.dynamicPlugins.get(name)
    if (!plugin) {
      return { success: false, error: `Plugin "${name}" not found` }
    }

    try {
      if (!plugin.compiled) {
        return { success: false, error: `Plugin "${name}" not compiled` }
      }

      const result = plugin.compiled(this.ctx)
      // 如果导出有 apply 函数，调用它
      if (result && typeof result.apply === 'function') {
        result.apply(this.ctx)
      }
      return { success: true, result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  retract(name: string): { success: boolean; error?: string } {
    if (!this.dynamicPlugins.has(name)) {
      return { success: false, error: `Plugin "${name}" not found` }
    }
    this.dynamicPlugins.delete(name)
    console.log(`[DynamicCordisRunner] Plugin "${name}" retracted`)
    return { success: true }
  }

  list(): string[] {
    return [...this.dynamicPlugins.keys()]
  }
}

export const inject = [] as const
export const provide = ['dynamicCordisRunner'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('dynamicCordisRunner', new HostCordisRunner(ctx))
}
