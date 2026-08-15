// @ts-nocheck
/**
 * Compaction Provider 插件 — 上下文压缩服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const compactionProvider: Plugin = (ctx: any) => {
  let threshold = 80000

  const dispose = ctx.provide('compaction', {
    check: async (messages: any[]) => {
      const tokenCount = messages.reduce((sum: number, m: any) => {
        const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')
        return sum + Math.ceil(content.length / 4)
      }, 0)
      return { needCompact: tokenCount > threshold, tokenCount }
    },
    compact: async (messages: any[]) => {
      const system = messages.filter((m: any) => m?.role === 'system')
      const recent = messages.slice(-10)
      return [...system, ...recent]
    },
    getThreshold() { return threshold },
    setThreshold(tokens: number) { threshold = tokens },
  })

  return dispose
}
