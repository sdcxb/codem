// @ts-nocheck
/**
 * @codem/session-checkpoint-policy — 检查点策略管理，频率触发条件保留策略
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionCheckpointPolicyProvider: Plugin = (ctx: any) => {
  const s = {
    policies: new Map([['interval',{type:'interval',intervalMs:30000,maxCk:10}],['on-tool-call',{type:'on-event',event:'tool-call',maxCk:20}],['on-error',{type:'on-event',event:'error',maxCk:5}]]),
    active: 'interval',
    getPolicy(n) { return this.policies.get(n||this.active) },
    setPolicy(n, p) { this.policies.set(n, p) },
    setActive(n) { if(this.policies.has(n))this.active=n },
    shouldCheckpoint(ev) { const p=this.getPolicy(); if(!p)return false; if(p.type==='interval')return !ev.lastCheckpoint||Date.now()-ev.lastCheckpoint>=p.intervalMs; if(p.type==='on-event')return ev.type===p.event; return false },
  }
  return ctx.provide('sessionCheckpointPolicy', s)
}
