// @ts-nocheck
/**
 * @codem/atomic-write — 原子写入文件，写入失败时保持原文件不变
 */
import type { Plugin } from '../cordis/src/index.ts'

export const atomicWriteProvider: Plugin = (ctx: any) => {
  const s = {
    async writeFile(filePath, content) { const {writeFileSync,renameSync}=await import('fs'); const p=await import('path'); const tmp=p.join(p.dirname(filePath),'.'+p.basename(filePath)+'.tmp-'+Date.now()); try{writeFileSync(tmp,content,'utf8'); renameSync(tmp,filePath); return true}catch(e){try{const{unlinkSync}=await import('fs'); unlinkSync(tmp)}catch (e) { console.warn('[atomic-write-provider.ts]', e) } throw e} },
    async writeJSON(filePath, data) { return this.writeFile(filePath, JSON.stringify(data, null, 2)) },
  }
  return ctx.provide('atomicWrite', s)
}
