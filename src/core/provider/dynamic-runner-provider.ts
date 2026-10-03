// @ts-nocheck
/**
 * Dynamic Runner Provider — 自指运行时（动态插件）
 *
 * ## 第 104 波：`new Function` → **Rust 侧沙箱会话**
 *
 * 原来这里两处 `new Function('ctx', wrapped)`（`createWorker` 与 `define`）在装好的应用里
 * **直接抛 CSP 违规**（CSP 不含 `unsafe-eval`）—— 动态插件在真机上是死功能。
 *
 * 现在：每个插件开一个**沙箱会话**（`js_sandbox_open`，Rust 侧 boa 引擎 + 专属线程）。
 * 会话形态解决两件单发执行做不到的事：
 *  · **环境持久**：`define` 时跑插件代码、`run` 时再调它的实例方法（`Context` 得活着）；
 *  · **宿主回调 guest 函数**：`ctx.provide('myService', { hello: () => 'world' })` 交出去的
 *    函数由宿主在建代理时登记 handle，之后 `service.hello()` 走 `js_sandbox_call_function`
 *    回到 guest 里执行（这正是"服务"能用的关键）。
 *
 * 闸门不变：`validateCode` 预检仍然在 `define` 之前跑（早失败 + 一句人话）；
 * 真正的边界是沙箱本身（guest 里没有 `process` / `require` / `window` / `__TAURI__`）。
 *
 * ⚠️ 沙箱里**不支持**的 Cordis ctx 面（`get` / `on` / `plugin`）会抛一句可读错误，
 * 而不是 `undefined is not a function` —— 插件作者一眼知道该怎么办。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { validateCode } from './validate-dynamic-code.ts'

/** 插件在宿主的登记项 */
interface DynamicPlugin {
  name: string
  code: string
  sessionId: number
  /** `ctx.provide` 交出来的服务：服务名 → 宿主侧代理对象（函数会回调 guest） */
  services: Map<string, unknown>
  /** Cordis 的注销函数（retract 时要还回去，不能留悬空服务） */
  disposers: Map<string, () => void>
}

interface ProvidedDescriptor {
  name: string
  functions: Record<string, number>
  data: Record<string, unknown>
}

export const dynamicRunnerProvider: Plugin = (ctx: any) => {
  const dynamicPlugins = new Map<string, DynamicPlugin>()

  /** 把 `ctx.provide` 的描述符变成宿主可用对象：数据照搬，函数变成"回调 guest"的代理 */
  const buildServiceProxy = (descriptor: ProvidedDescriptor, sessionId: number) => {
    const service: Record<string, unknown> = { ...(descriptor.data ?? {}) }
    for (const [key, handle] of Object.entries(descriptor.functions ?? {})) {
      service[key] = async (...args: unknown[]) => {
        const { callSandboxFunction } = await import('../js/js-remote-runtime.ts')
        return await callSandboxFunction(sessionId, handle, args)
      }
    }
    // 服务名对插件自己可见（与 Cordis 里 `service.name` 的习惯一致）
    if (service.name === undefined) service.name = descriptor.name
    return service
  }

  const dispose = ctx.provide('dynamicCordisRunner', {
    _active: true,

    inspect() {
      const plugins = [...dynamicPlugins.values()].map((p) => ({
        name: p.name,
        provides: [...p.services.keys()],
        inject: [],
        isDynamic: true,
      }))
      const services = [...dynamicPlugins.values()].flatMap((p) => [...p.services.keys()])
      return { plugins, services }
    },

    async define(name: string, code: string) {
      if (dynamicPlugins.has(name)) {
        return { success: false, error: `Plugin "${name}" already defined` }
      }

      // 预检：危险 API 早失败（真正的边界是沙箱，这里只是让错误更早、更好懂）
      const validation = validateCode(code)
      if (!validation.ok) {
        return { success: false, error: validation.error }
      }

      const services = new Map<string, unknown>()
      const disposers = new Map<string, () => void>()
      try {
        const { openSandboxSession } = await import('../js/js-remote-runtime.ts')
        const sessionId = await openSandboxSession({
          code,
          loopLimit: 2_000_000,
          onProvide: async (descriptor: ProvidedDescriptor) => {
            const service = buildServiceProxy(descriptor, sessionId)
            services.set(descriptor.name, service)
            /**
             * **真的注册进 Cordis**（这才是 `ctx.provide` 的意义：别的代码/插件要能 `get` 到它）。
             * 少了这一步，插件的服务只有它自己看得见 —— 判据 PLUGIN-3 就是因为这个红的。
             */
            try {
              const disposeService = ctx.provide(descriptor.name, service)
              if (typeof disposeService === 'function') disposers.set(descriptor.name, disposeService)
            } catch (error) {
              console.warn('[dynamic-runner-provider] 注册服务失败：', error)
            }
            return { ok: true }
          },
        })
        dynamicPlugins.set(name, { name, code, sessionId, services, disposers })
        console.log(`[DynamicRunner] Plugin "${name}" defined (sandboxed session ${sessionId})`)
        return { success: true, sessionId }
      } catch (err: any) {
        return { success: false, error: String(err?.message ?? err) }
      }
    },

    async run(name: string, args?: any) {
      const p = dynamicPlugins.get(name)
      if (!p) {
        return { success: false, error: `Plugin "${name}" not found` }
      }
      try {
        const { evalInSandboxSession } = await import('../js/js-remote-runtime.ts')
        // 工厂形态（`module.exports = (ctx) => ({...})`）与对象形态都支持
        await evalInSandboxSession(
          p.sessionId,
          `
          globalThis.__plugin = (typeof module.exports === "function") ? module.exports(ctx) : module.exports;
          "ok"
          `,
        )
        const hasRun = await evalInSandboxSession(
          p.sessionId,
          `typeof (globalThis.__plugin && globalThis.__plugin.run) === "function"`,
        )
        if (hasRun) {
          const result = await evalInSandboxSession(
            p.sessionId,
            `globalThis.__plugin.run(${JSON.stringify(args ?? null)})`,
          )
          return { success: true, result }
        }
        // 没有 run：把实例当成结果（函数属性不会进 JSON，这是沙箱的既有边界）
        const snapshot = await evalInSandboxSession(p.sessionId, `globalThis.__plugin`)
        return { success: true, result: snapshot }
      } catch (err: any) {
        return { success: false, error: String(err?.message ?? err) }
      }
    },

    async retract(name: string) {
      const p = dynamicPlugins.get(name)
      if (!p) {
        return { success: false, error: `Plugin "${name}" not found` }
      }
      const { evalInSandboxSession, closeSandboxSession } = await import('../js/js-remote-runtime.ts')
      // 插件自己的 dispose（有就调；调不动也不能挡住关闭）
      try {
        await evalInSandboxSession(
          p.sessionId,
          `(typeof globalThis.__plugin?.dispose === "function") && globalThis.__plugin.dispose()`,
        )
      } catch (error) {
        console.warn('[dynamic-runner-provider]', error)
      }
      // 把注册进 Cordis 的服务还回去（留悬空服务 = 之后谁 get 到谁踩坑）
      for (const [serviceName, disposeService] of p.disposers) {
        try {
          disposeService()
        } catch (error) {
          console.warn(`[dynamic-runner-provider] 注销服务 ${serviceName} 失败：`, error)
        }
      }
      await closeSandboxSession(p.sessionId)
      dynamicPlugins.delete(name)
      console.log(`[DynamicRunner] Plugin "${name}" retracted`)
      return { success: true }
    },

    list() {
      return [...dynamicPlugins.keys()]
    },
  })

  // Composite dispose — 关掉所有动态插件的会话
  const compositeDispose = () => {
    void (async () => {
      const { closeSandboxSession } = await import('../js/js-remote-runtime.ts')
      for (const p of dynamicPlugins.values()) {
        try {
          await closeSandboxSession(p.sessionId)
        } catch (error) {
          console.warn('[dynamic-runner-provider]', error)
        }
      }
      dynamicPlugins.clear()
    })()
    dispose()
  }
  return compositeDispose
}

class HostCordisRunner {
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
