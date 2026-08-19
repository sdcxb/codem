// @ts-nocheck
/**
 * @codem/spill-local — 本地溢出，溢出数据保存到本地存储
 */
import type { Plugin } from '../cordis/src/index.ts'

export const spillLocalProvider: Plugin = (ctx: any) => {
  const s = {
    async save(sessionId, spilledData) { const {writeFileSync,existsSync,mkdirSync}=await import('fs'); const p=await import('path'); const d=p.join(process.cwd(),'.codem','spill'); if(!existsSync(d))mkdirSync(d,{recursive:true}); writeFileSync(p.join(d,sessionId+'.json'),JSON.stringify(spilledData),'utf8') },
    async load(sessionId) { const {readFileSync,existsSync}=await import('fs'); const p=await import('path'); const f=p.join(process.cwd(),'.codem','spill',sessionId+'.json'); if(!existsSync(f))return null; return JSON.parse(readFileSync(f,'utf8')) },
    async remove(sessionId) { const {unlinkSync,existsSync}=await import('fs'); const p=await import('path'); const f=p.join(process.cwd(),'.codem','spill',sessionId+'.json'); if(existsSync(f))unlinkSync(f) },
  }
  return ctx.provide('spillLocal', s)
}
