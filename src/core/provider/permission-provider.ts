// @ts-nocheck
/**
 * Permission Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { PermissionManager } from '../permission/permission'

export const permissionProvider: Plugin = (ctx: any) => {
  // 在 Provider 内部创建实例，生命周期与 fiber 绑定
  const permMgr = new PermissionManager()

  const dispose = ctx.provide('permission', {
    check: (action: string, resource?: any) => permMgr.check(action, resource),
    request: async (action: string, resource?: any) => permMgr.request(action, resource),
    grant: (action: string) => permMgr.grant(action),
    revoke: (action: string) => permMgr.revoke(action),
  })

  return dispose
}
