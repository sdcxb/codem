// @ts-nocheck
/**
 * Hooks Provider 插件 — 事件钩子服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const hooksProvider: Plugin = (ctx: any) => {
  const hookHandlers = new Map<string, Array<{ type: string; handler: (...args: any[]) => any }>>()

  const dispose = ctx.provide('hooks', {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!hookHandlers.has(event)) hookHandlers.set(event, [])
      hookHandlers.get(event)!.push({ type: 'on', handler })
      return () => { hookHandlers.set(event, (hookHandlers.get(event) || []).filter(h => h.handler !== handler)) }
    },
    before: (event: string, handler: (...args: any[]) => any) => {
      if (!hookHandlers.has(event)) hookHandlers.set(event, [])
      hookHandlers.get(event)!.push({ type: 'before', handler })
      return () => { hookHandlers.set(event, (hookHandlers.get(event) || []).filter(h => h.handler !== handler)) }
    },
    after: (event: string, handler: (...args: any[]) => any) => {
      if (!hookHandlers.has(event)) hookHandlers.set(event, [])
      hookHandlers.get(event)!.push({ type: 'after', handler })
      return () => { hookHandlers.set(event, (hookHandlers.get(event) || []).filter(h => h.handler !== handler)) }
    },
    emit: (event: string, ...args: any[]) => {
      const handlers = hookHandlers.get(event) || []
      for (const h of handlers) {
        if (h.type === 'on' || h.type === 'after') h.handler(...args)
      }
    },
  })

  return dispose
}
