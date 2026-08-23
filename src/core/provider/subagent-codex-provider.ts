// @ts-nocheck
/**
 * @codem/subagent-codex — Codex 子 Agent，通过 Codex 协议创建子 Agent
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subagentCodexProvider: Plugin = (ctx: any) => {
  const s = {
    async create(config) { const sub=ctx.get('subagent'); if(!sub)throw new Error('Subagent not available'); return sub.create?sub.create({...config,type:'codex'}):{id:'codex-'+Date.now(),...config,type:'codex'} },
    async run(id, input) {
      const llm=ctx.get('llm')
      if(llm&&llm.complete){
        const result = await llm.complete({
          messages: [
            { role: 'system', content: 'You are a Codex subagent. Execute tasks efficiently and return results.' },
            { role: 'user', content: input },
          ],
        })
        return typeof result === 'string' ? result : (result?.content || result?.text || 'No output')
      }
      return 'Codex subagent (simulated)'
    },
    async terminate(id) { const sub=ctx.get('subagent'); if(sub&&sub.remove)sub.remove(id) },
  }
  return ctx.provide('subagentCodex', s)
}
