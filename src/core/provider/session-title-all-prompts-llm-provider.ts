// @ts-nocheck
/**
 * @codem/session-title-all-prompts-llm — 所有提示词综合生成会话标题，全局摘要
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionTitleAllPromptsLlmProvider: Plugin = (ctx: any) => {
  const s = {
    async generate(id) {
      const sess=ctx.get('session')
      if(!sess) return 'New Session'
      const msgs = sess.getMessages ? sess.getMessages(id) : []
      const um = msgs.filter(m=>m.role==='user')
      if(!um.length) return 'New Session'
      const txt = um.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join(' | ')
      const llm = ctx.get('llm')
      if(llm && llm.complete) {
        try {
          const result = await llm.complete({
            messages: [
              { role: 'system', content: 'Summarize the conversation into a short title (max 6 words). Reply with ONLY the title.' },
              { role: 'user', content: txt.slice(0, 500) },
            ],
            maxTokens: 30,
          })
          const title = typeof result === 'string' ? result : (result?.content || result?.text || '')
          return title.trim().replace(/^["']|["']$/g,'')
        } catch(e) {
          console.warn('[sessionTitleAllPrompts] LLM complete failed', e)
        }
      }
      return txt.slice(0,60) + (txt.length>60 ? '...' : '')
    },
  }
  return ctx.provide('sessionTitleAllPrompts', s)
}
