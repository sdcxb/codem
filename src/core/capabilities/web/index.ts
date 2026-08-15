// @ts-nocheck
/**
 * @codem/web — Web 能力族 Service Definition
 *
 * 定义网络搜索和抓取接口契约。Provider 包实现此接口。
 * 替代原有 seam/types.ts 中的 WebSeam。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface Web {
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>
  fetch(url: string): Promise<string>
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** Web 服务（搜索和抓取，可替换 Provider） */
    web: Web
  }
}
