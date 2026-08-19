// @ts-nocheck
/**
 * @codem/session-persistence-jsonl — JSONL 格式会话持久化，追加写入高性能
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionPersistenceJsonlProvider: Plugin = (ctx: any) => {
  const s = {
    async save(id, msgs) { const {appendFileSync,existsSync,mkdirSync}=await import('fs'); const p=await import('path'); const d=p.join(process.cwd(),'.codem','sessions'); if(!existsSync(d))mkdirSync(d,{recursive:true}); appendFileSync(p.join(d,id+'.jsonl'), msgs.map(m=>JSON.stringify(m)).join('\n')+'\n','utf8') },
    async load(id) { const {readFileSync,existsSync}=await import('fs'); const p=await import('path'); const f=p.join(process.cwd(),'.codem','sessions',id+'.jsonl'); if(!existsSync(f))return []; return readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)) },
    async append(id, msg) { const {appendFileSync}=await import('fs'); const p=await import('path'); appendFileSync(p.join(process.cwd(),'.codem','sessions',id+'.jsonl'), JSON.stringify(msg)+'\n','utf8') },
  }
  return ctx.provide('sessionPersistenceJSONL', s)
}
