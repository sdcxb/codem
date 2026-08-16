// @ts-nocheck
/**
 * LSP Provider 插件 — 包装真实 LSP 实现并接入 ctx。
 *
 * 真实实现源：src/core/llm/tools/lsp-tool.ts（385 行完整实现）
 * 支持：definition / references / hover / document_symbols / workspace_symbols
 *
 * 接入点：
 * - LLM 工具 `lsp_*` 系列通过 ctx.lsp 获取符号信息
 * - 第三方插件可通过 ctx.lsp 注册自定义语言服务器
 */
import type { Plugin } from '../cordis/src/index.ts'
import { execLspTool } from '../llm/tools/lsp-tool.ts'

export const lspProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('lsp', {
    async definition(filePath: string, line: number, character: number) {
      return execLspTool('definition', { filePath, line, character })
    },
    async references(filePath: string, line: number, character: number) {
      return execLspTool('references', { filePath, line, character })
    },
    async hover(filePath: string, line: number, character: number) {
      return execLspTool('hover', { filePath, line, character })
    },
    async documentSymbols(filePath: string) {
      return execLspTool('document_symbols', { filePath })
    },
    async workspaceSymbols(query: string) {
      return execLspTool('workspace_symbols', { query })
    },
  })

  return dispose
}
