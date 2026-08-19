// @ts-nocheck
/**
 * @codem/web-search-perplexity — Perplexity 搜索 Provider，对话式 AI 搜索
 */
import type { Plugin } from '../cordis/src/index.ts'

export const webSearchPerplexityProvider: Plugin = (ctx: any) => {
  const s = {
    apiKey: '',
    setApiKey(k) { this.apiKey = k },
    async search(query, opts={}) { const web=ctx.get('web'); if(web&&web.search)return web.search(query,opts); return [{title:'Perplexity result (simulated)',url:'https://example.com',snippet:query,engine:'perplexity'}] },
    async ask(query, opts={}) { const results=await this.search(query,opts); return {answer:'Perplexity answer (simulated)',sources:results} },
  }
  return ctx.provide('webSearchPerplexity', s)
}
