// @ts-nocheck
/**
 * Dynamic Runner Provider 插件 — Self-Referential Runtime，可独立加载/卸载/热替换。
 * Agent 运行时通过此服务自行定义和加载插件。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const dynamicRunnerProvider: Plugin = (ctx: any) => {
  const dynamicPlugins = new Map<string, any>()

  const dispose = ctx.provide('dynamicCordisRunner', {
    inspect() {
      const plugins = [...dynamicPlugins.values()].map(p => ({ name: p.name, provides: p.provides || [], inject: p.inject || [], isDynamic: true }))
      const services = Object.keys(ctx).filter(k => !k.startsWith('_') && typeof (ctx as any)[k] !== 'undefined')
      return { plugins, services }
    },
    async define(name: string, code: string) {
      if (dynamicPlugins.has(name)) return { success: false, error: `Plugin "${name}" already defined` }
      try {
        const wrappedCode = `const module = { exports: {} }; const exports = module.exports; ${code}; return module.exports;`
        const compiled = new Function('ctx', wrappedCode)
        dynamicPlugins.set(name, { name, code, compiled })
        return { success: true }
      } catch (err: any) { return { success: false, error: err.message } }
    },
    async run(name: string, args?: any) {
      const p = dynamicPlugins.get(name)
      if (!p) return { success: false, error: `Plugin "${name}" not found` }
      try {
        const result = p.compiled(ctx)
        if (result && typeof result.apply === 'function') result.apply(ctx)
        return { success: true, result }
      } catch (err: any) { return { success: false, error: err.message } }
    },
    retract(name: string) {
      if (!dynamicPlugins.has(name)) return { success: false, error: `Plugin "${name}" not found` }
      dynamicPlugins.delete(name)
      return { success: true }
    },
    list() { return [...dynamicPlugins.keys()] },
  })

  return dispose
}
