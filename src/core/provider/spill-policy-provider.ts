// @ts-nocheck
/**
 * @codem/spill-policy — 溢出策略，溢出触发条件和保留策略管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const spillPolicyProvider: Plugin = (ctx: any) => {
  const s = {
    policies: new Map([['threshold',{type:'threshold',maxContext:8000,spillRatio:0.5}],['topic',{type:'topic',groupBy:'topic',maxPerGroup:20}]]),
    active: 'threshold',
    getPolicy(n) { return this.policies.get(n||this.active) },
    setPolicy(n, p) { this.policies.set(n, p) },
    setActive(n) { if(this.policies.has(n))this.active=n },
    evaluate(contextLength, messages) { const p=this.getPolicy(); if(p.type==='threshold')return contextLength>=p.maxContext; if(p.type==='topic')return messages.length>=p.maxPerGroup*2; return false },
  }
  return ctx.provide('spillPolicy', s)
}
