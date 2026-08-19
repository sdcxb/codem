// @ts-nocheck
/**
 * @codem/skill-filesystem — 技能文件系统，从文件系统加载技能定义
 */
import type { Plugin } from '../cordis/src/index.ts'

export const skillFilesystemProvider: Plugin = (ctx: any) => {
  const s = {
    skillsDir: '.codem/skills',
    async load(dir) { const {readdirSync,readFileSync,existsSync}=await import('fs'); const p=await import('path'); const d=dir||p.join(process.cwd(),this.skillsDir); if(!existsSync(d))return []; const files=readdirSync(d).filter(f=>f.endsWith('.md')||f.endsWith('.yaml')||f.endsWith('.json')); return files.map(f=>{const content=readFileSync(p.join(d,f),'utf8'); return{name:f.replace(/\.[^.]+$/,''),file:f,content}}) },
    async save(name, content) { const {writeFileSync,existsSync,mkdirSync}=await import('fs'); const p=await import('path'); const d=p.join(process.cwd(),this.skillsDir); if(!existsSync(d))mkdirSync(d,{recursive:true}); writeFileSync(p.join(d,name+'.md'),content,'utf8'); return true },
  }
  return ctx.provide('skillFilesystem', s)
}
