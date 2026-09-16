// @ts-nocheck
/**
 * Hooks Provider 插件 — 包装真实 Hook 管理器并接入 ctx。
 *
 * 真实实现源：src/core/hooks/hook-manager.ts
 * 支持：PreToolUse / PostToolUse 钩子 + 超时 + 命令/函数钩子 + **运行时钩子**（程序注册）
 *
 * 接入点：
 * - ToolPipeline 的 HookPreExecute/HookPostExecute 中间件调用 HookManager 的
 *   executePreToolHooks / executePostToolHooks（配置钩子与运行时钩子一起生效）
 * - 第三方插件通过 ctx.get('hooks').register(event, handler) 注册自定义钩子
 *
 * 第 86 波（审计修正）：这个 service 原来调用的是 `manager.register` /
 * `manager.executeHooks` / `manager.listHooks` / `manager.clearAllHooks` ——
 * **HookManager 上根本没有这四个方法**（只有基于 settings 的配置钩子）。于是：
 *   · 任何插件调 `ctx.hooks.register(...)` 立刻 TypeError；
 *   · `clearAllHooks()` 是个空函数（注释还写着"Map 会自动回收"，但 manager 一直被
 *     service 引用着），禁用插件不会清掉任何钩子；
 *   · 服务却对外声称 `_active: true`，看起来一切正常。
 * 现在 HookManager 补齐了运行时钩子 API，这里改为直接转发，语义与注释一致。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { HookManager } from '../hooks/hook-manager.ts'

export const hooksProvider: Plugin = (ctx: any) => {
  const manager = new HookManager()

  const service = {
    _active: true,
    /** 注册运行时钩子（返回 id，可用于 unregister） */
    register(event: string, handler: any, options?: { timeout?: number; name?: string }): string {
      return manager.register(event as any, handler, options)
    },
    unregister(event: string, handlerId: string): boolean {
      return manager.unregister(event as any, handlerId)
    },
    async executeHooks(event: string, payload: any): Promise<any[]> {
      return manager.executeHooks(event as any, payload)
    },
    listHooks(event?: string): any[] {
      return manager.listHooks(event as any)
    },
    /** D3-3: 清理所有**运行时**注册的钩子（配置钩子在 settings 里，需用 removeHook） */
    clearAllHooks(): void {
      manager.clearAllHooks()
    },
    /** 诊断：当前运行时钩子数量 */
    runtimeHookCount(): number {
      return manager.runtimeHookCount()
    },
  }

  const dispose = ctx.provide('hooks', service)

  // D3-2/D3-3: Composite dispose — 清理定时器和事件
  const compositeDispose = () => {
    // D3-2: 标记为非活跃
    service._active = false
    // 清空所有运行时注册的钩子，防止引用泄漏（走真实实现，不再是空函数）
    try { manager.clearAllHooks() } catch (e) { console.warn('[hooks-provider]', e) }
    dispose()
  }
  return compositeDispose
}
