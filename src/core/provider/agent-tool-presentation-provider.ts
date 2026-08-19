// @ts-nocheck
/**
 * @codem/agent-tool-presentation — 工具结果展示策略，格式化工具调用输出
 */
import type { Plugin } from '../cordis/src/index.ts'

export const agentToolPresentationProvider: Plugin = (ctx: any) => {
  const s = {
    formatters: new Map(),
    register(name: string, fn: (r: any) => string) { this.formatters.set(name, fn) },
    format(name: string, result: any): string {
      const f = this.formatters.get(name)
      if (f) return f(result)
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    },
    summarize(result: any, max = 500): string {
      const t = typeof result === 'string' ? result : JSON.stringify(result)
      return t.length > max ? t.slice(0, max) + '...' : t
    },
  }
  return ctx.provide('agentToolPresentation', s)
}
