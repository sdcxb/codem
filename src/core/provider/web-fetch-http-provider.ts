// @ts-nocheck
/**
 * @codem/web-fetch-http — HTTP 网页抓取插件 (P2-7.11)
 *
 * 提供 HTTP 网页抓取能力，将 HTML 转为 Markdown。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链 → web_fetch 工具）：
 * - 启动时：注册 web fetch 服务，LLM 可调用 web_fetch 工具
 * - 停止时：web_fetch 工具不可用，LLM 无法获取网页内容
 */
import type { Plugin } from '../cordis/src/index.ts'

class WebFetchHttp {
  async fetch(url: string, options?: { timeout?: number; maxRedirects?: number }): Promise<{ url: string; content: string; status: number }> {
    const timeout = options?.timeout || 30000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MiMoBot/1.0)' },
      })

      const html = await response.text()
      const content = this.htmlToMarkdown(html)

      return { url: response.url, content, status: response.status }
    } finally {
      clearTimeout(timer)
    }
  }

  private htmlToMarkdown(html: string): string {
    return html
      // 移除 script/style
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // 标题
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
      // 段落
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
      // 链接
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      // 代码
      .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n')
      // 列表
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      // 换行
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      // 移除剩余标签
      .replace(/<[^>]+>/g, '')
      // 清理 HTML 实体
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // 压缩空行
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
}

export const webFetchHttpProvider: Plugin = (ctx: any) => {
  const fetcher = new WebFetchHttp()

  const dispose = ctx.provide('webFetchHttp', {
    async fetch(url: string, options?: any) { return fetcher.fetch(url, options) },
  })

  return dispose
}
