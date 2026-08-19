// @ts-nocheck
/**
 * @codem/sandbox-windows-acl — Windows ACL 沙箱，基于访问控制列表的权限隔离
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sandboxWindowsAclProvider: Plugin = (ctx: any) => {
  const s = {
    acls: new Map(),
    setAcl(path, acl) { this.acls.set(path, acl) },
    getAcl(path) { return this.acls.get(path) },
    async checkAccess(path, op) { const acl=this.getAcl(path); if(!acl)return true; if(acl.deny?.includes(op))return false; if(acl.allow?.length&&!acl.allow.includes(op))return false; return true },
    async exec(cmd, opts={}) { const sb=ctx.get('sandbox'); if(sb&&sb.exec)return sb.exec(cmd,[],{...opts,platform:'windows'}); throw new Error('Sandbox not available') },
  }
  return ctx.provide('sandboxWindowsAcl', s)
}
