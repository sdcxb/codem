// @ts-nocheck
/**
 * @codem/agent — Agent 管理器，Agent 实例创建、注册和生命周期管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const agentProvider: Plugin = (ctx: any) => {
  const s = {
    agents: new Map(),
    create(id: string, config: any) {
      const agent = { id, ...config, status: 'idle', createdAt: Date.now() }
      this.agents.set(id, agent)
      const reg = ctx.get('agentRegistry')
      if (reg) reg.register(agent)
      return agent
    },
    get(id: string) { return this.agents.get(id) },
    list() { return [...this.agents.values()] },
    remove(id: string) {
      this.agents.delete(id)
      const reg = ctx.get('agentRegistry')
      if (reg) reg.unregister(id)
    },
  }
  return ctx.provide('agentManager', s)
}
