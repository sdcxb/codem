// @ts-nocheck
/**
 * Web Provider 插件 — Web 搜索/抓取服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const webProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('web', {
    search: async (query: string) => {
      // 委托给 webSearchMimo（如果可用），否则使用基础实现
      try {
        const webSearchMimo = ctx.get('webSearchMimo')
        if (webSearchMimo) return await webSearchMimo.search(query)
      } catch (e) { console.warn('[web] webSearchMimo search failed', e) }
      try {
        const { webSearch } = await import('../llm/tools/web-search')
        return await webSearch(query)
      } catch (e) { console.warn('[web] webSearch import failed', e); return [] }
    },
    fetch: async (url: string) => {
      // 委托给 webFetchHttp（如果可用），否则使用基础实现
      try {
        const webFetchHttp = ctx.get('webFetchHttp')
        if (webFetchHttp) {
          const result = await webFetchHttp.fetch(url)
          return result.content
        }
      } catch (e) { console.warn('[web] webFetchHttp fetch failed', e) }
      const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(20_000) })
      return response.text()
    },
  })

  return dispose
}
