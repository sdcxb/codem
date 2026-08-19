// @ts-nocheck
/**
 * @codem/cordis-client-runner — Cordis 客户端运行器，客户端 Cordis 实例管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const cordisClientRunnerProvider: Plugin = (ctx: any) => {
  const s = {
    runners: new Map(),
    async start(id, config) { const r={id,config,status:'running',startedAt:Date.now()}; this.runners.set(id,r); return r },
    async stop(id) { const r=this.runners.get(id); if(r)r.status='stopped'; return true },
    get(id) { return this.runners.get(id) },
    list() { return [...this.runners.values()] },
  }
  return ctx.provide('cordisClientRunner', s)
}
