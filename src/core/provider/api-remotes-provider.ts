// @ts-nocheck
/**
 * @codem/api-remotes — 远程 API，远程服务调用和管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const apiRemotesProvider: Plugin = (ctx: any) => {
  const s = {
    remotes: new Map(),
    register(name, config) { this.remotes.set(name, config) },
    unregister(name) { this.remotes.delete(name) },
    get(name) { return this.remotes.get(name) },
    async call(name, method, params) { const r=this.remotes.get(name); if(!r)throw new Error('Remote not found: '+name); const sdk=ctx.get('sdkProtocol'); if(sdk&&sdk.call)return sdk.call(method, params); return {simulated:true,remote:name,method} },
    list() { return [...this.remotes.keys()] },
  }
  return ctx.provide('apiRemotes', s)
}
