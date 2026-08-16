// @ts-nocheck
/**
 * Code Runtime Provider 插件 — 包装真实代码执行实现并接入 ctx。
 *
 * 真实实现源：src/core/llm/tools/run-code.ts（179 行完整实现）
 * 支持：TypeScript 沙箱执行 + ToolSDK + 超时保护
 *
 * 接入点：
 * - LLM 工具 `run_code` 通过 ctx.codeRuntime 执行代码
 * - 第三方插件可通过 ctx.codeRuntime 注册自定义运行时
 */
import type { Plugin } from '../cordis/src/index.ts'
import { execRunCode } from '../llm/tools/run-code.ts'

export const codeRuntimeProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('codeRuntime', {
    async run(code: string, options?: { timeout?: number; cwd?: string }) {
      return execRunCode(code, options)
    },
    async runWithSDK(code: string, sdk: any, options?: { timeout?: number }) {
      return execRunCode(code, { ...options, sdk })
    },
  })

  return dispose
}
