// @ts-nocheck
/**
 * @codem/session-reference — 会话交叉引用，消息间引用关系管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionReferenceProvider: Plugin = (ctx: any) => {
  const s = {
    refs: new Map(),
    add(from, to, type='reply') { if(!this.refs.has(from))this.refs.set(from,[]); this.refs.get(from).push({toMsgId:to,type,createdAt:Date.now()}) },
    get(id) { return this.refs.get(id)||[] },
    getBackrefs(id) { const r=[]; for(const [f,rl] of this.refs) for(const ref of rl) if(ref.toMsgId===id)r.push({fromMsgId:f,...ref}); return r },
    remove(id) { this.refs.delete(id); for(const [f,rl] of this.refs) this.refs.set(f, rl.filter(r=>r.toMsgId!==id)) },
  }
  return ctx.provide('sessionReference', s)
}
