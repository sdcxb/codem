// @ts-nocheck
/**
 * @codem/agent-default-model — 默认模型选择策略，根据任务类型自动选择最佳模型
 */
import type { Plugin } from '../cordis/src/index.ts'

export const agentDefaultModelProvider: Plugin = (ctx: any) => {
  const s = {
    defaults: new Map([['code', 'gpt-4o'], ['chat', 'gpt-4o-mini'], ['reasoning', 'o1-preview'], ['vision', 'gpt-4o']]),
    getDefault(t: string) { return this.defaults.get(t) || 'gpt-4o' },
    setDefault(t: string, m: string) { this.defaults.set(t, m) },
    resolveModel(t: string, p?: string) { return p || this.getDefault(t) },
  }
  return ctx.provide('agentDefaultModel', s)
}
