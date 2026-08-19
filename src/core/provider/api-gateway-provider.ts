// @ts-nocheck
/**
 * @codem/api-gateway — API 网关，统一入口路由和认证
 */
import type { Plugin } from '../cordis/src/index.ts'

export const apiGatewayProvider: Plugin = (ctx: any) => {
  const s = {
    routes: new Map(), middleware: [],
    addRoute(path, handler) { this.routes.set(path, handler) },
    removeRoute(path) { this.routes.delete(path) },
    use(mw) { this.middleware.push(mw) },
    async handle(path, request) { for(const mw of this.middleware){const r=await mw(request); if(r)return r} const handler=this.routes.get(path); if(handler)return handler(request); return{status:404,body:'Not found'} },
    listRoutes() { return [...this.routes.keys()] },
  }
  return ctx.provide('apiGateway', s)
}
