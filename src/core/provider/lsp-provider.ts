// @ts-nocheck
/**
 * LSP Provider 插件 — 语言服务协议，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const lspProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('lsp', {
    async start(_workspace: string) { return crypto.randomUUID() },
    async stop(_id: string) {},
    async getDiagnostics(_file: string) { return [] },
    async hover(_file: string, _line: number, _col: number) { return null },
    async completions(_file: string, _line: number, _col: number) { return [] },
  })

  return dispose
}
