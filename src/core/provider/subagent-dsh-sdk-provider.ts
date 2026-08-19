// @ts-nocheck
/**
 * @codem/subagent-dsh-sdk — DSH SDK 子 Agent，通过 DSH SDK 创建子 Agent
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subagentDshSdkProvider: Plugin = (ctx: any) => {
  const s = {
    async create(config) { const sub=ctx.get('subagent'); if(!sub)throw new Error('Subagent not available'); return sub.create?sub.create({...config,type:'dsh-sdk'}):{id:'dsh-'+Date.now(),...config,type:'dsh-sdk'} },
    async run(id, input) { const sdk=ctx.get('sdkProtocol'); if(sdk&&sdk.call) { try { return await sdk.call('agent.run', {input}) } catch (e) { console.warn('[subagent-dsh-sdk-provider.ts]', e) } } return 'DSH SDK subagent (simulated)' },
    async terminate(id) { const sub=ctx.get('subagent'); if(sub&&sub.remove)sub.remove(id) },
  }
  return ctx.provide('subagentDshSdk', s)
}
