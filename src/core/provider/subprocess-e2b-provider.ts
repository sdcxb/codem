// @ts-nocheck
/**
 * @codem/subprocess-e2b — E2B 子进程，远程沙箱进程管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subprocessE2bProvider: Plugin = (ctx: any) => {
  const s = {
    async spawn(sid, cmd, args=[], opts={}) { return {pid:Date.now(),stdout:'',stderr:'',exitCode:0,killed:false,kill(){this.killed=true}} },
    async exec(sid, cmd, opts={}) { const e=ctx.get('e2b'); if(!e)throw new Error('E2B not available'); return e.exec(sid, cmd, opts) },
    async kill(sid, pid) { return true },
  }
  return ctx.provide('subprocessE2b', s)
}
