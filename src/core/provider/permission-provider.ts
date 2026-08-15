// @ts-nocheck
/**
 * Permission Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getPermissionManager } from '../permission/permission'

export const permissionProvider: Plugin = (ctx: any) => {
  const permMgr = getPermissionManager()

  const dispose = ctx.provide('permission', {
    check: (action: string, resource?: any) => permMgr.check(action, resource),
    request: async (action: string, resource?: any) => permMgr.request(action, resource),
    grant: (action: string) => permMgr.grant(action),
    revoke: (action: string) => permMgr.revoke(action),
  })

  return dispose
}
