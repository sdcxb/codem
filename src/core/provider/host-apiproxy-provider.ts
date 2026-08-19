// @ts-nocheck
/**
 * @codem/host-apiproxy — API 代理，反向代理和请求转发
 */
import type { Plugin } from '../cordis/src/index.ts'

export const hostApiproxyProvider: Plugin = (ctx: any) => {
  const s = {
    routes: new Map(),
    add(path, target) { this.routes.set(path, target) },
    remove(path) { this.routes.delete(path) },
    async proxy(path, request) { const target=this.routes.get(path); if(!target)throw new Error('No proxy target for '+path); return {target,proxied:true,status:200,body:'Proxied (simulated)'} },
    list() { return [...this.routes.entries()].map(([p,t])=>({path:p,target:t})) },
  }
  return ctx.provide('hostApiproxy', s)
}
