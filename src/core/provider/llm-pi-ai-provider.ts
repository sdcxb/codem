// @ts-nocheck
/**
 * @codem/llm-pi-ai — Pi AI LLM Provider，Inflection Pi 模型适配器
 */
import type { Plugin } from '../cordis/src/index.ts'

export const llmPiAiProvider: Plugin = (ctx: any) => {
  const s = {
    id: 'pi-ai', name: 'Pi AI',
    baseUrl: 'https://api.inflection.ai/v1',
    models: [{id:'pi-2',name:'Pi 2',contextWindow:8000},{id:'pi-2-mini',name:'Pi 2 Mini',contextWindow:4000}],
    async complete(messages, opts={}) { const llm=ctx.get('llm'); if(llm&&llm.complete)return llm.complete(messages,{...opts,model:opts.model||'pi-2'}); throw new Error('LLM service not available') },
  }
  const llm = ctx.get('llm'); let disp=null; if(llm&&llm.registerProvider)disp=llm.registerProvider('pi-ai',s); else ctx.provide('llmPiAi',s); return ()=>{if(disp)disp()}
}

