// @ts-nocheck
/**
 * @codem/lsp-stdio — LSP stdio 传输，标准输入输出传输层适配
 */
import type { Plugin } from '../cordis/src/index.ts'

export const lspStdioProvider: Plugin = (ctx: any) => {
  const s = {
    transport: 'stdio',
    async start(serverPath, opts={}) { const {spawn}=await import('child_process'); try{const proc=spawn(serverPath,opts.args||[],{stdio:['pipe','pipe','pipe']}); return{pid:proc.pid,process:proc,transport:'stdio'}}catch(e){return{error:e.message}} },
    async send(proc, message) { if(proc&&proc.process)proc.process.stdin.write(JSON.stringify(message)+'\r\n') },
    async onMessage(proc, cb) { if(proc&&proc.process)proc.process.stdout.on('data',d=>{try{cb(JSON.parse(d.toString()))}catch (e) { console.warn('[lsp-stdio-provider.ts]', e) }}) },
    async stop(proc) { if(proc&&proc.process)proc.process.kill() },
  }
  return ctx.provide('lspStdio', s)
}
