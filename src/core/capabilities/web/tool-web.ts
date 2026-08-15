// @ts-nocheck
/**
 * @codem/tool-web — Web 工具 Consumer
 *
 * 通过 ctx.web 消费 Web 能力，注册 web_search 和 web_fetch 工具。
 */
import { defineTool, useCtx } from '../../consumer/index.ts'

export const inject = ['web', 'tools'] as const

export function apply() {
  const ctx = useCtx()

  defineTool({
    name: 'web_search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
    async execute({ query }: { query: string }) {
      const results = await ctx.web.search(query)
      return results.map(r => `[${r.title}](${r.url})\n${r.snippet}`).join('\n\n')
    },
  })

  defineTool({
    name: 'web_fetch',
    description: 'Fetch the content of a web page',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
    async execute({ url }: { url: string }) {
      return ctx.web.fetch(url)
    },
  })
}
