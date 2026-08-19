// @ts-nocheck
/**
 * @codem/tool-fs-search — 文件搜索工具，独立插件形式的文件内容名称搜索
 */
import type { Plugin } from '../cordis/src/index.ts'

export const toolFsSearchProvider: Plugin = (ctx: any) => {
  const s = {
    async searchFiles(q, o={}) { const {readdirSync,statSync}=await import('fs'); const p=await import('path'); const cwd=o.cwd||process.cwd(); const max=o.maxResults||50; const ig=o.ignorePatterns||['node_modules','.git','dist']; const res=[]; (function walk(dir){if(res.length>=max)return; let ent=[]; try{ent=readdirSync(dir)}catch{return}; for(const e of ent){if(res.length>=max)break; if(ig.some(x=>e.includes(x)))continue; const fp=p.join(dir,e); try{if(statSync(fp).isDirectory())walk(fp); else if(e.toLowerCase().includes(q.toLowerCase()))res.push({path:fp,name:e})}catch (e) { console.warn('[tool-fs-search-provider.ts]', e) }}})(cwd); return res },
    async searchContent(pat, o={}) { const {readdirSync,readFileSync,statSync}=await import('fs'); const p=await import('path'); const cwd=o.cwd||process.cwd(); const max=o.maxResults||20; const res=[]; (function walk(dir){if(res.length>=max)return; let ent=[]; try{ent=readdirSync(dir)}catch{return}; for(const e of ent){if(res.length>=max)break; if(['node_modules','.git','dist'].some(x=>e.includes(x)))continue; const fp=p.join(dir,e); try{if(statSync(fp).isDirectory())walk(fp); else{const c=readFileSync(fp,'utf8'); c.split('\n').forEach((line,i)=>{if(res.length<max&&line.includes(pat))res.push({path:fp,line:i+1,text:line.trim()})})}}catch (e) { console.warn('[tool-fs-search-provider.ts]', e) }}})(cwd); return res },
  }
  return ctx.provide('toolFsSearch', s)
}
