// @ts-nocheck
/**
 * Permissions Provider 插件 — 包装真实权限预设系统并接入 ctx。
 *
 * 真实实现源：
 * - src/core/permission/permission.ts（PermissionManager 类）
 * - src/core/permission/security-mode.ts（完整权限预设/安全模式系统）
 *
 * 接入点：
 * - ToolPipeline 调用 ctx.permissions.check(tool, args) 检查权限
 * - Settings UI 通过 ctx.permissions.listModes() 列出可选安全模式
 * - 第三方插件通过 ctx.permissions.registerMode() 注册自定义安全模式
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getPermissionManager, getSecurityModes } from '../permission/permission.ts'

export const permissionsProvider: Plugin = (ctx: any) => {
  const manager = getPermissionManager(ctx)
  const modes = getSecurityModes()

  const dispose = ctx.provide('permissions', {
    check(toolName: string, args: any, mode?: string): { allowed: boolean; reason?: string } {
      return manager.checkPermission(toolName, args, mode)
    },
    listModes(): Array<{ name: string; description: string; riskLevel: string }> {
      return modes
    },
    getMode(name: string): any {
      return modes.find(m => m.name === name)
    },
    setMode(name: string): void {
      manager.setSecurityMode(name)
    },
    getActiveMode(): string {
      return manager.getActiveSecurityMode()
    },
    registerMode(name: string, config: any): void {
      modes.push({ name, ...config })
    },
  })

  return dispose
}
