// @ts-nocheck
/**
 * @codem/subprocess-local — 本地子进程管理，进程创建和生命周期控制
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subprocessLocalProvider: Plugin = (ctx: any) => {
  const s = {
    async spawn(cmd, args=[], opts={}) { const {spawn}=await import('child_process'); const proc=spawn(cmd,args,{stdio:'pipe',...opts}); return {pid:proc.pid,stdout:'',stderr:'',killed:false,kill(){proc.kill();this.killed=true},on(ev,cb){proc.on(ev,cb)}} },
    async exec(cmd, opts={}) { const {execSync}=await import('child_process'); try{const r=execSync(cmd,{encoding:'utf8',...opts}); return{stdout:r,stderr:'',exitCode:0}}catch(e){return{stdout:'',stderr:e.message,exitCode:1}} },
  }
  return ctx.provide('subprocessLocal', s)
}
