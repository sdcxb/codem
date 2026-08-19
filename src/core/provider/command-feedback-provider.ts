// @ts-nocheck
/**
 * @codem/command-feedback — 命令反馈，用户对 Agent 回复的反馈收集
 */
import type { Plugin } from '../cordis/src/index.ts'

export const commandFeedbackProvider: Plugin = (ctx: any) => {
  const s = {
    feedback: new Map(),
    async submit(messageId, type, comment) { const f={messageId,type,comment,createdAt:Date.now()}; if(!this.feedback.has(messageId))this.feedback.set(messageId,[]); this.feedback.get(messageId).push(f); return f },
    get(messageId) { return this.feedback.get(messageId)||[] },
    stats() { let positive=0,negative=0; for(const fs of this.feedback.values())for(const f of fs){if(f.type==='like')positive++; if(f.type==='dislike')negative++} return {positive,negative,total:positive+negative} },
  }
  return ctx.provide('commandFeedback', s)
}
