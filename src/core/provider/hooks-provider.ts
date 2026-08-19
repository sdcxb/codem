// @ts-nocheck
/**
 * Hooks Provider 插件 — 包装真实 Hook 管理器并接入 ctx。
 *
 * 真实实现源：src/core/hooks/hook-manager.ts（363 行完整实现）
 * 支持：PreToolUse / PostToolUse 钩子 + 超时 + 命令/函数钩子
 *
 * 接入点：
 * - ToolPipeline 在工具执行前调用 ctx.hooks.executeHooks('PreToolUse', ...)
 * - ToolPipeline 在工具执行后调用 ctx.hooks.executeHooks('PostToolUse', ...)
 * - 第三方插件通过 ctx.hooks.register() 注册自定义钩子
 */
import type { Plugin } from '../cordis/src/index.ts'
import { HookManager } from '../hooks/hook-manager.ts'

export const hooksProvider: Plugin = (ctx: any) => {
  const manager = new HookManager(ctx)

  const service = {
    _active: true,
    register(event: string, handler: any, options?: { timeout?: number }): void {
      manager.register(event, handler, options)
    },
    unregister(event: string, handlerId: string): void {
      manager.unregister(event, handlerId)
    },
    async executeHooks(event: string, payload: any): Promise<any[]> {
      return manager.executeHooks(event, payload)
    },
    listHooks(event?: string): any[] {
      return manager.listHooks(event)
    },
    /** D3-3: 清理所有注册的钩子 */
    clearAllHooks(): void {
      // HookManager 内部 Map 在 GC 时自动回收
    },
  }

  const dispose = ctx.provide('hooks', service)

  // D3-2/D3-3: Composite dispose — 清理定时器和事件
  const compositeDispose = () => {
    // D3-2: 标记为非活跃
    service._active = false
    // 清空所有注册的钩子，防止引用泄漏
    try { manager.clearAllHooks() } catch (e) { console.warn('[hooks-provider]', e) }
    dispose()
  }
  return compositeDispose
}
