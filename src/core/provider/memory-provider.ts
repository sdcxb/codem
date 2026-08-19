// @ts-nocheck
/**
 * Memory Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { MemoryService } from '../memory/memory'

export const memoryProvider: Plugin = (ctx: any) => {
  // 在 Provider 内部创建实例，生命周期与 fiber 绑定
  const memory = new MemoryService()

  const dispose = ctx.provide('memory', {
    add: (entry: any) => memory.add(entry),
    query: (filter: any) => memory.query(filter),
    clear: () => memory.clear(),
    getScopes: () => ['global', 'session', 'project'],
  })

  return dispose
}
