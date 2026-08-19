// @ts-nocheck
/**
 * @codem/tool-call-timeout-policy — 工具调用超时策略，不同工具的超时配置
 */
import type { Plugin } from '../cordis/src/index.ts'

export const toolCallTimeoutPolicyProvider: Plugin = (ctx: any) => {
  const s = {
    timeouts: new Map([['bash',30000],['fs',10000],['web',15000],['default',60000]]),
    getTimeout(toolName) { return this.timeouts.get(toolName)||this.timeouts.get('default')||60000 },
    setTimeout(toolName, ms) { this.timeouts.set(toolName, ms) },
    removeTimeout(toolName) { this.timeouts.delete(toolName) },
    list() { return [...this.timeouts.entries()].map(([k,v])=>({tool:k,timeoutMs:v})) },
  }
  return ctx.provide('toolCallTimeoutPolicy', s)
}
