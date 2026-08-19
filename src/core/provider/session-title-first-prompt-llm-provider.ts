// @ts-nocheck
/**
 * @codem/session-title-first-prompt-llm — 首条提示词生成会话标题，快速命名
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionTitleFirstPromptLlmProvider: Plugin = (ctx: any) => {
  const s = {
    async generate(id) { const sess=ctx.get('session'); if(!sess)return'New Session'; const msgs=sess.getMessages?sess.getMessages(id):[]; const f=msgs.find(m=>m.role==='user'); if(!f||!f.content)return'New Session'; const t=typeof f.content==='string'?f.content:JSON.stringify(f.content); const title=t.slice(0,60).trim(); return title.length<t.length?title+'...':title },
  }
  return ctx.provide('sessionTitleFirstPrompt', s)
}
