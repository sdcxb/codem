// @ts-nocheck
/**
 * @codem/web-search-exa — Exa 搜索引擎 Provider，AI 优化搜索结果
 */
import type { Plugin } from '../cordis/src/index.ts'

export const webSearchExaProvider: Plugin = (ctx: any) => {
  const s = {
    apiKey: '',
    setApiKey(k) { this.apiKey = k },
    async search(query, opts={}) { const web=ctx.get('web'); if(web&&web.search)return web.search(query,opts); return [{title:'Exa result (simulated)',url:'https://example.com',snippet:query,engine:'exa'}] },
    async searchWithContent(query, opts={}) { const results=await this.search(query,opts); return results.map(r=>({...r,content:r.snippet||''})) },
  }
  return ctx.provide('webSearchExa', s)
}
