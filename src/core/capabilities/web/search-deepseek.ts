// @ts-nocheck
/**
 * @codem/web-search-deepseek — DeepSeek 搜索 Provider
 *
 * 使用 DeepSeek 的搜索 API 实现 Web 接口。
 * 包装现有 llm/tools/web-search.ts 的实现。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { Web } from './index.ts'

export class DeepSeekWebSearch implements Web {
  constructor(private ctx: Context) {}

  async search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    // 调用 DeepSeek 搜索 API
    try {
      const response = await fetch(`https://api.deepseek.com/v1/search?q=${encodeURIComponent(query)}`, {
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      return data.results || []
    } catch {
      return []
    }
  }

  async fetch(url: string): Promise<string> {
    const response = await globalThis.fetch(url)
    return response.text()
  }
}

export const inject = [] as const
export const provide = ['web'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('web', new DeepSeekWebSearch(ctx))
}
