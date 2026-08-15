// @ts-nocheck
/**
 * Code Runtime Provider 插件 — 代码执行服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const codeRuntimeProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('codeRuntime', {
    async execute(_code: string, _language: string, _cwd?: string) {
      return { stdout: '', stderr: 'Code runtime not available in browser', exitCode: 1 }
    },
  })

  return dispose
}
