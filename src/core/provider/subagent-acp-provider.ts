// @ts-nocheck
/**
 * @codem/subagent-acp — ACP 协议子 Agent，通过 ACP 协议编排子 Agent
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subagentAcpProvider: Plugin = (ctx: any) => {
  const s = {
    async create(config) { const sub=ctx.get('subagent'); if(!sub)throw new Error('Subagent not available'); return sub.create?sub.create(config):{id:config.id||'acp-'+Date.now(),...config} },
    async send(id, msg) { return {response:'ACP subagent response (simulated)',from:id} },
    async terminate(id) { const sub=ctx.get('subagent'); if(sub&&sub.remove)sub.remove(id) },
  }
  return ctx.provide('subagentAcp', s)
}
