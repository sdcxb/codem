// @ts-nocheck
/**
 * @codem/subagent-claude-code — Claude Code 子 Agent，通过 Claude Code SDK 创建子 Agent
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subagentClaudeCodeProvider: Plugin = (ctx: any) => {
  const s = {
    async create(config) { const sub=ctx.get('subagent'); if(!sub)throw new Error('Subagent not available'); return sub.create?sub.create({...config,type:'claude-code'}):{id:'claude-'+Date.now(),...config,type:'claude-code'} },
    async run(id, input) { const llm=ctx.get('llm'); if(llm&&llm.complete)return llm.complete('You are a Claude Code subagent.\n'+input); return 'Claude Code subagent (simulated)' },
    async terminate(id) { const sub=ctx.get('subagent'); if(sub&&sub.remove)sub.remove(id) },
  }
  return ctx.provide('subagentClaudeCode', s)
}
