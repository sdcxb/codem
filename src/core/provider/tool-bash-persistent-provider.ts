// @ts-nocheck
/**
 * @codem/tool-bash-persistent — 持久化 Bash 会话，跨工具调用保持工作目录和环境
 */
import type { Plugin } from '../cordis/src/index.ts'

export const toolBashPersistentProvider: Plugin = (ctx: any) => {
  const s = {
    sessions: new Map(),
    create(id) { const ss={id,cwd:process.cwd(),env:{...process.env},history:[]}; this.sessions.set(id,ss); return ss },
    async exec(id, cmd, o={}) { let ss=this.sessions.get(id); if(!ss)ss=this.create(id); ss.history.push(cmd); const sh=ctx.get('shell'); if(!sh)throw new Error('Shell not available'); const r=sh.exec?await sh.exec(cmd,{...o,cwd:ss.cwd,env:ss.env}):{stdout:'',stderr:'No shell'}; if(r&&r.cwd)ss.cwd=r.cwd; return r },
    getCwd(id) { return this.sessions.get(id)?.cwd||process.cwd() },
    getHistory(id) { return this.sessions.get(id)?.history||[] },
    destroy(id) { this.sessions.delete(id) },
  }
  return ctx.provide('toolBashPersistent', s)
}
