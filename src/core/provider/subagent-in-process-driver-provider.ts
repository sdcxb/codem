// @ts-nocheck
/**
 * @codem/subagent-in-process-driver — 进程内子 Agent 驱动，管理子 Agent 生命周期和调度
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subagentInProcessDriverProvider: Plugin = (ctx: any) => {
  const s = {
    drivers: new Map(),
    start(id, config) { const driver={id,config,status:'running',startedAt:Date.now(),messages:[]}; this.drivers.set(id,driver); return driver },
    async send(id, message) { const d=this.drivers.get(id); if(!d)throw new Error('Driver not found'); d.messages.push(message); const sub=ctx.get('subagent'); if(sub&&sub.send)return sub.send(id,message); return {response:'Driver response (simulated)'} },
    stop(id) { const d=this.drivers.get(id); if(d)d.status='stopped' },
    getStatus(id) { return this.drivers.get(id)?.status||'unknown' },
    list() { return [...this.drivers.values()] },
  }
  return ctx.provide('subagentInProcessDriver', s)
}
