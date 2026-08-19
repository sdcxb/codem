// @ts-nocheck
/**
 * @codem/session-projection-cache — 会话投影缓存，热数据内存索引加速查询
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionProjectionCacheProvider: Plugin = (ctx: any) => {
  const s = { cache: new Map(), max: 1000, get(id){return this.cache.get(id)}, set(id,v){if(this.cache.size>=this.max){const k=this.cache.keys().next().value;this.cache.delete(k)}this.cache.set(id,{...v,cachedAt:Date.now()})}, invalidate(id){this.cache.delete(id)}, clear(){this.cache.clear()}, stats(){return{entries:this.cache.size,max:this.max}} }
  return ctx.provide('sessionProjectionCache', s)
}
