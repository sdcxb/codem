// @ts-nocheck
/**
 * Security Mode Provider 插件 — 包装真实安全模式系统并接入 ctx。
 *
 * 真实实现源：src/core/permission/security-mode.ts
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('securityMode') 评估权限
 * - ToolPipeline 通过 ctx.get('securityMode') 检查写操作确认
 * - 替代直接 import { evaluateWithSecurityMode, getEffectiveSecurityMode }
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  SECURITY_MODES,
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  getProjectSecurityMode,
  setProjectSecurityMode,
  getEffectiveSecurityMode,
  shouldShowWriteConfirm,
  shouldCheckPermissions,
  evaluateWithSecurityMode,
} from '../permission/security-mode.ts'

export const securityModeProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('securityMode', {
    getGlobal(): string {
      return getGlobalSecurityMode()
    },
    setGlobal(mode: string): void {
      return setGlobalSecurityMode(mode as any)
    },
    getProject(projectPath: string): string | null {
      return getProjectSecurityMode(projectPath)
    },
    setProject(projectPath: string, mode: string | null): void {
      return setProjectSecurityMode(projectPath, mode as any)
    },
    getEffective(projectPath?: string): string {
      return getEffectiveSecurityMode(projectPath)
    },
    shouldShowWriteConfirm(mode: string): boolean {
      return shouldShowWriteConfirm(mode as any)
    },
    shouldCheckPermissions(mode: string): boolean {
      return shouldCheckPermissions(mode as any)
    },
    evaluate(tool: string, args: any, mode?: string) {
      return evaluateWithSecurityMode(tool, args, mode as any)
    },
    listModes() {
      return SECURITY_MODES
    },
  })

  return dispose
}
