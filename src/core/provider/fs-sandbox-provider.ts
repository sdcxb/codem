// @ts-nocheck
/**
 * @codem/fs-sandbox — 沙箱文件系统，隔离的虚拟文件系统操作
 */
import type { Plugin } from '../cordis/src/index.ts'

export const fsSandboxProvider: Plugin = (ctx: any) => {
  const s = {
    sandboxes: new Map(),
    create(id, root) { const sb={id,rootPath:root,files:new Map(),allowedPaths:[root]}; this.sandboxes.set(id,sb); return sb },
    async readFile(id, fp) { const sb=this.sandboxes.get(id); if(!sb)throw new Error('Sandbox not found'); const p=await import('path'); const full=p.resolve(sb.rootPath,fp); if(!full.startsWith(sb.rootPath))throw new Error('Path outside sandbox'); const fs=ctx.get('fs'); return fs?await fs.readFile(full):null },
    async writeFile(id, fp, c) { const sb=this.sandboxes.get(id); if(!sb)throw new Error('Sandbox not found'); const p=await import('path'); const full=p.resolve(sb.rootPath,fp); if(!full.startsWith(sb.rootPath))throw new Error('Path outside sandbox'); const fs=ctx.get('fs'); if(fs)await fs.writeFile(full,c) },
    async list(id, dp='.') { const sb=this.sandboxes.get(id); if(!sb)throw new Error('Sandbox not found'); const p=await import('path'); const full=p.resolve(sb.rootPath,dp); const fs=ctx.get('fs'); return fs?await fs.readdir(full):[] },
    destroy(id) { this.sandboxes.delete(id) },
  }
  return ctx.provide('fsSandbox', s)
}
