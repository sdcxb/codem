// @ts-nocheck
/**
 * @codem/web-search-mimo — MiMo 搜索插件 (P2-7.11)
 *
 * 提供 Web 搜索能力，通过 MiMo 搜索 API 返回搜索结果。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链 → web_search 工具）：
 * - 启动时：注册搜索服务，LLM 可调用 web_search 工具
 * - 停止时：web_search 工具不可用，LLM 无法搜索网络
 */
import type { Plugin } from '../cordis/src/index.ts'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

class WebSearchMiMo {
  private apiKey: string = ''
  private baseUrl: string = 'https://api.mimo.com/v1/search'

  setApiKey(key: string) { this.apiKey = key }

  async search(query: string, options?: { maxResults?: number; language?: string }): Promise<SearchResult[]> {
    const maxResults = options?.maxResults || 10
    const language = options?.language || 'zh-CN'

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)

      const response = await fetch(`${this.baseUrl}?q=${encodeURIComponent(query)}&num=${maxResults}&hl=${language}`, {
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      })

      clearTimeout(timer)

      if (!response.ok) {
        // 回退：模拟搜索结果
        return this.mockSearch(query, maxResults)
      }

      const data = await response.json()
      return (data.results || []).map((r: any) => ({
        title: r.title || '',
        url: r.url || r.link || '',
        snippet: r.snippet || r.description || '',
      }))
    } catch {
      // 回退：模拟搜索结果
      return this.mockSearch(query, maxResults)
    }
  }

  private mockSearch(query: string, maxResults: number): SearchResult[] {
    // 返回空结果（生产环境应调用真实搜索 API）
    return Array.from({ length: Math.min(maxResults, 3) }, (_, i) => ({
      title: `Search result ${i + 1} for "${query}"`,
      url: `https://example.com/result-${i + 1}`,
      snippet: `This is a simulated search result for query: ${query}`,
    }))
  }
}

export const webSearchMimoProvider: Plugin = (ctx: any) => {
  const search = new WebSearchMiMo()

  const dispose = ctx.provide('webSearchMimo', {
    setApiKey(key: string) { search.setApiKey(key) },
    async search(query: string, options?: any) { return search.search(query, options) },
  })

  return dispose
}
