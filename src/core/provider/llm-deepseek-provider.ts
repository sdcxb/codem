// @ts-nocheck
/**
 * @codem/llm-deepseek — DeepSeek 原生 API Provider，支持 DeepSeek Chat/Coder/V3
 */
import type { Plugin } from '../cordis/src/index.ts'

export const llmDeepseekProvider: Plugin = (ctx: any) => {
  const s = {
    id: 'deepseek', name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [{id:'deepseek-chat',name:'DeepSeek Chat',contextWindow:64000},{id:'deepseek-coder',name:'DeepSeek Coder',contextWindow:64000},{id:'deepseek-reasoner',name:'DeepSeek V3',contextWindow:64000}],
    async complete(messages, opts={}) { const llm=ctx.get('llm'); if(llm&&llm.complete)return llm.complete(messages,{...opts,model:opts.model||'deepseek-chat'}); throw new Error('LLM service not available') },
    async *stream(messages, opts={}) { const llm=ctx.get('llm'); if(llm&&llm.stream){yield* llm.stream(messages,{...opts,model:opts.model||'deepseek-chat'})} else yield{type:'text',text:'DeepSeek not available'} },
  }
  const llm = ctx.get('llm'); let disp=null; if(llm&&llm.registerProvider)disp=llm.registerProvider('deepseek',s); else ctx.provide('llmDeepseek',s); return ()=>{if(disp)disp()}
}

