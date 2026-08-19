// @ts-nocheck
/**
 * @codem/e2b — E2B 云沙箱，远程隔离代码执行环境
 */
import type { Plugin } from '../cordis/src/index.ts'

export const e2bProvider: Plugin = (ctx: any) => {
  const s = {
    sandboxes: new Map(), apiKey: '',
    setApiKey(k) { this.apiKey = k },
    async create(opts={}) { const id='e2b-'+Date.now(); this.sandboxes.set(id,{id,status:'running',...opts}); return {id,...opts} },
    async exec(id, cmd, opts={}) { const sb=this.sandboxes.get(id); if(!sb)throw new Error('E2B sandbox not found: '+id); return {stdout:'E2B exec simulated',stderr:'',exitCode:0,cmd} },
    async readFile(id, fp) { return 'E2B file content (simulated)' },
    async writeFile(id, fp, c) { return true },
    async destroy(id) { this.sandboxes.delete(id) },
    list() { return [...this.sandboxes.values()] },
  }
  return ctx.provide('e2b', s)
}
