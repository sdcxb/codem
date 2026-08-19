// @ts-nocheck
/**
 * @codem/fs-e2b — E2B 文件系统，远程沙箱文件操作
 */
import type { Plugin } from '../cordis/src/index.ts'

export const fsE2bProvider: Plugin = (ctx: any) => {
  const s = {
    async readFile(sid, fp) { const e=ctx.get('e2b'); if(!e)throw new Error('E2B not available'); return e.readFile(sid, fp) },
    async writeFile(sid, fp, c) { const e=ctx.get('e2b'); if(!e)throw new Error('E2B not available'); return e.writeFile(sid, fp, c) },
    async list(sid, dp='.') { return [{path:dp,name:'(simulated)',type:'dir'}] },
    async remove(sid, fp) { return true },
  }
  return ctx.provide('fsE2b', s)
}
