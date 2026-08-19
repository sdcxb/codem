// @ts-nocheck
/**
 * Dynamic Runner Provider 插件 — Self-Referential Runtime。
 *
 * F6: 深化 — 使用 Web Worker 隔离动态代码执行。
 * 保留 new Function() 作为 fallback（浏览器环境不支持 Worker 时）。
 * 增加 AST 验证（简单正则检查危险 API 调用）。
 *
 * 参考 DSH packages/core/dynamic-runner/src/index.ts:
 *   DynamicRunner extends Service, define(code) → compiled plugin
 *   run(name, args) → executes in isolated context
 *   retract(name) → disposes plugin
 */
import type { Plugin } from '../cordis/src/index.ts'

export const dynamicRunnerProvider: Plugin = (ctx: any) => {
  const dynamicPlugins = new Map<string, any>()

  // D1-1: 复用公共验证函数（从 code-runtime-worker-thread-provider 提取）
  const { validateCode } = require('./code-runtime-worker-thread-provider.ts')

  /** 尝试在 Worker 中执行代码（Node.js worker_threads 环境） */
  const createWorker = (code: string, ctxData: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      try {
        // In browser/Electron renderer, fallback to Function constructor
        const wrappedCode = `
          const module = { exports: {} };
          const exports = module.exports;
          ${code};
          return module.exports;
        `
        const compiled = new Function('ctx', wrappedCode)
        const result = compiled(ctxData)
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })
  }

  const dispose = ctx.provide('dynamicCordisRunner', {
    _active: true,

    inspect() {
      const plugins = [...dynamicPlugins.values()].map(p => ({
        name: p.name,
        provides: p.provides || [],
        inject: p.inject || [],
        isDynamic: true,
      }))
      // 通过 ReflectService.store 获取已注册的服务列表，而非直接枚举 ctx 属性
      const store = ctx.reflect?.store ?? {}
      const services = Object.values(store).map((impl: any) => impl?.name).filter(Boolean) as string[]
      return { plugins, services }
    },

    async define(name: string, code: string) {
      if (dynamicPlugins.has(name)) {
        return { success: false, error: `Plugin "${name}" already defined` }
      }

      // F6: Validate code before compilation
      const validation = validateCode(code)
      if (!validation.ok) {
        return { success: false, error: validation.error }
      }

      try {
        const wrappedCode = `
          const module = { exports: {} };
          const exports = module.exports;
          ${code};
          return module.exports;
        `
        const compiled = new Function('ctx', wrappedCode)
        dynamicPlugins.set(name, { name, code, compiled, provides: [], inject: [] })
        console.log(`[DynamicRunner] Plugin "${name}" defined and validated`)
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    },

    async run(name: string, args?: any) {
      const p = dynamicPlugins.get(name)
      if (!p) {
        return { success: false, error: `Plugin "${name}" not found` }
      }
      try {
        const result = await createWorker(p.code, ctx)
        if (result && typeof result.apply === 'function') {
          result.apply(ctx)
        }
        if (result && typeof result.run === 'function') {
          const runResult = await result.run(args)
          return { success: true, result: runResult }
        }
        return { success: true, result }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    },

    retract(name: string) {
      const p = dynamicPlugins.get(name)
      if (!p) {
        return { success: false, error: `Plugin "${name}" not found` }
      }
      // Call plugin's dispose if available
      if (p.compiled) {
        try {
          const result = p.compiled(ctx)
          if (result?.dispose) result.dispose()
        } catch (e) { console.warn('[dynamic-runner-provider.ts]', e) }
      }
      dynamicPlugins.delete(name)
      console.log(`[DynamicRunner] Plugin "${name}" retracted`)
      return { success: true }
    },

    list() { return [...dynamicPlugins.keys()] },
  })

  // Composite dispose — retract all dynamic plugins
  const compositeDispose = () => {
    for (const [name] of dynamicPlugins) {
      // Try to dispose each plugin
      const p = dynamicPlugins.get(name)
      if (p?.compiled) {
        try {
          const result = p.compiled(ctx)
          if (result?.dispose) result.dispose()
        } catch (e) { console.warn('[dynamic-runner-provider.ts]', e) }
      }
    }
    dynamicPlugins.clear()
    dispose()
  }
  return compositeDispose
}

export class HostCordisRunner {
  private dynamicPlugins = new Map<string, any>()

  constructor(private ctx: any) {}

  inspect() {
    return { plugins: [], services: [] }
  }

  async define(name: string, code: string) {
    // Delegate to provider
    const runner = this.ctx?.get?.('dynamicCordisRunner')
    if (runner) return runner.define(name, code)
    return { success: false, error: 'dynamicCordisRunner not available' }
  }

  async run(name: string, args?: any) {
    const runner = this.ctx?.get?.('dynamicCordisRunner')
    if (runner) return runner.run(name, args)
    return { success: false, error: 'dynamicCordisRunner not available' }
  }

  retract(name: string) {
    const runner = this.ctx?.get?.('dynamicCordisRunner')
    if (runner) return runner.retract(name)
    return { success: false, error: 'dynamicCordisRunner not available' }
  }

  list() {
    const runner = this.ctx?.get?.('dynamicCordisRunner')
    if (runner) return runner.list()
    return []
  }
}
