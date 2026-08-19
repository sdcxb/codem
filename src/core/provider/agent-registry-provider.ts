// @ts-nocheck
/**
 * Agent Registry Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 AgentRegistry 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getAgentRegistry()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { AgentRegistry } from '../agent/agent'

export const agentRegistryProvider: Plugin = (ctx: any) => {
  const registry = new AgentRegistry()

  const dispose = ctx.provide('agentRegistry', {
    register(def: any) { registry.register(def) },
    get(id: string) { return registry.get(id) },
    getAll() { return registry.getAll() },
    getPrimary() { return registry.getPrimary() },
    getSubagents() { return registry.getSubagents() },
  })

  return dispose
}
