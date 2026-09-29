// @ts-nocheck
/**
 * @codem/tool-str-replace-editor — 字符串替换编辑器工具，精确查找替换文件内容
 */
import type { Plugin } from '../cordis/src/index.ts'
import { replaceLiteral } from '../llm/edit-matchers.ts'

export const toolStrReplaceEditorProvider: Plugin = (ctx: any) => {
  const s = {
    async view(fp, range) { const fs=ctx.get('fs'); if(!fs)throw new Error('FS not available'); const c=await fs.readFile(fp); const lines=c.split('\n'); const [s,e]=range||[1,lines.length]; return lines.slice(s-1,e).map((l,i)=>(s+i)+': '+l).join('\n') },
    async create(fp, content) { const fs=ctx.get('fs'); if(!fs)throw new Error('FS not available'); await fs.writeFile(fp,content); return 'File created: '+fp },
    // 用 replaceLiteral 而非 c.replace(oldStr,newStr)：后者会把 newStr 里的
    // $& / $$ / $` / $' 当替换记号展开，静默改写文件却返回成功（详见 edit-matchers.ts）
    async strReplace(fp, oldStr, newStr) { const fs=ctx.get('fs'); if(!fs)throw new Error('FS not available'); const c=await fs.readFile(fp); const next=replaceLiteral(c,oldStr,newStr); if(next===null)throw new Error('old_string not found'); await fs.writeFile(fp,next); return 'File updated: '+fp },
    async insert(fp, afterLine, content) { const fs=ctx.get('fs'); if(!fs)throw new Error('FS not available'); let c=await fs.readFile(fp); const lines=c.split('\n'); lines.splice(afterLine,0,content); await fs.writeFile(fp,lines.join('\n')); return 'Inserted at line '+afterLine },
    async undo(fp) { const fs=ctx.get('fs'); if(fs&&fs.undo)await fs.undo(fp) },
  }
  return ctx.provide('toolStrReplaceEditor', s)
}
