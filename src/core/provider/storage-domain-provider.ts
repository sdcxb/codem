// @ts-nocheck
/**
 * @codem/storage-domain — 存储域定义，分域存储命名空间管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const storageDomainProvider: Plugin = (ctx: any) => {
  const s = {
    domains: new Map([['default',{name:'Default',path:''}],['sessions',{name:'Sessions',path:'sessions'}],['plugins',{name:'Plugins',path:'plugins'}],['cache',{name:'Cache',path:'cache',ttl:3600}]]),
    get(name) { return this.domains.get(name)||this.domains.get('default') },
    set(name, config) { this.domains.set(name, config) },
    list() { return [...this.domains.values()] },
    resolvePath(domain, key) { const d=this.get(domain); return d.path?d.path+'/'+key:key },
  }
  return ctx.provide('storageDomain', s)
}
