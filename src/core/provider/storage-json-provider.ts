// @ts-nocheck
/**
 * @codem/storage-json — JSON 存储后端，基于 JSON 文件的键值存储
 */
import type { Plugin } from '../cordis/src/index.ts'

export const storageJsonProvider: Plugin = (ctx: any) => {
  const s = {
    data: new Map(), file: '.codem/storage.json',
    async load() { const {readFileSync,existsSync}=await import('fs'); const p=await import('path'); const f=p.join(process.cwd(),this.file); if(!existsSync(f))return; try{const d=JSON.parse(readFileSync(f,'utf8')); for(const[k,v]of Object.entries(d))this.data.set(k,v)}catch (e) { console.warn('[storage-json-provider.ts]', e) } },
    async save() { const {writeFileSync,existsSync,mkdirSync}=await import('fs'); const p=await import('path'); const f=p.join(process.cwd(),this.file); const dir=p.dirname(f); if(!existsSync(dir))mkdirSync(dir,{recursive:true}); writeFileSync(f,JSON.stringify(Object.fromEntries(this.data)),'utf8') },
    get(key) { return this.data.get(key) },
    async set(key, value) { this.data.set(key,value); await this.save() },
    async remove(key) { this.data.delete(key); await this.save() },
    keys() { return [...this.data.keys()] },
  }
  return ctx.provide('storageJson', s)
}
