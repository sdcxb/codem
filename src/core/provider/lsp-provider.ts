/**
 * LSP Provider 插件 — 把真实 LSP 实现接到 `ctx.lsp` 上。
 *
 * ★ 第 185 波（复审发现并修复）：这个文件的参数名**全部对不上**工具的 schema ——
 * 工具要 `{file,line,column,symbol}`，而这里传的是 `{filePath,line,character,query}`
 * ⇒ `args.file` 恒 undefined ⇒ **五个方法必然失败**（`ctx.lsp.*` 整条通道是死的），
 * 而文件头的 `// @ts-nocheck` 让类型系统**看不见**它（这正是它藏了这么久的原因）。
 *
 * 现在做了三件事：
 *  1. 参数名对齐工具 schema；
 *  2. 去掉 `@ts-nocheck`，让类型系统重新看着这个文件；
 *  3. 每个方法多一个可选 `cwd`：透传给工具，否则经这条入口读文件会绕过工作区检查
 *     （工具内部原来用 `{}` 当 ctx ⇒ `ctx.cwd` 恒 undefined ⇒ 沙箱判据整条跳过）。
 *
 * 兼容性：`cwd` 是**可选尾参**，原有调用方（只传前几个参数）行为不变。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { execLspTool } from '../llm/tools/lsp-tool.ts'

export const lspProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('lsp', {
    async definition(filePath: string, line: number, character: number, cwd?: string) {
      return execLspTool('definition', { file: filePath, line, column: character }, cwd)
    },
    async references(filePath: string, line: number, character: number, cwd?: string) {
      return execLspTool('references', { file: filePath, line, column: character }, cwd)
    },
    async hover(filePath: string, line: number, character: number, cwd?: string) {
      return execLspTool('hover', { file: filePath, line, column: character }, cwd)
    },
    async documentSymbols(filePath: string, cwd?: string) {
      return execLspTool('document_symbols', { file: filePath }, cwd)
    },
    async workspaceSymbols(query: string, cwd?: string) {
      return execLspTool('workspace_symbols', { symbol: query }, cwd)
    },
  })

  return dispose
}
