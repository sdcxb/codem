// @ts-nocheck
/**
 * @codem/host-frontend-static — 前端静态文件服务，HTTP 静态资源托管
 */
import type { Plugin } from '../cordis/src/index.ts'

export const hostFrontendStaticProvider: Plugin = (ctx: any) => {
  const s = {
    rootDir: 'dist',
    setRoot(dir) { this.rootDir = dir },
    async serve(path) { const {readFileSync,existsSync}=await import('fs'); const p=await import('path'); const fp=p.join(this.rootDir,path); if(!existsSync(fp))return{status:404,body:'Not found'}; const ext=p.extname(fp); const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'}; return{status:200,body:readFileSync(fp,'utf8'),contentType:types[ext]||'application/octet-stream'} },
  }
  return ctx.provide('hostFrontendStatic', s)
}
