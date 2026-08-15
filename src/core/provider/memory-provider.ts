// @ts-nocheck
/**
 * Memory Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getMemoryService } from '../memory/memory'

export const memoryProvider: Plugin = (ctx: any) => {
  const memory = getMemoryService()

  const dispose = ctx.provide('memory', {
    add: (entry: any) => memory.add(entry),
    query: (filter: any) => memory.query(filter),
    clear: () => memory.clear(),
    getScopes: () => ['global', 'session', 'project'],
  })

  return dispose
}
