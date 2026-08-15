// @ts-nocheck
/**
 * Web Provider 插件 — Web 搜索/抓取服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const webProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('web', {
    search: async (query: string) => {
      try {
        const { webSearch } = await import('../llm/tools/web-search')
        return await webSearch(query)
      } catch { return [] }
    },
    fetch: async (url: string) => {
      const response = await globalThis.fetch(url)
      return response.text()
    },
  })

  return dispose
}
