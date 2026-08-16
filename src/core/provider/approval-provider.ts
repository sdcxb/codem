// @ts-nocheck
/**
 * Approval Provider 插件 — 包装真实审批流程并接入 ctx。
 *
 * 真实实现源：
 * - src/core/permission/permission.ts（PermissionManager 类，含审批流程）
 * - src/core/session/executor.ts（审批执行）
 *
 * 接入点：
 * - ToolPipeline 高风险操作时调用 ctx.approval.request() 请求用户审批
 * - UI 审批面板通过 ctx.approval.respond() 提交审批结果
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getPermissionManager } from '../permission/permission.ts'

export const approvalProvider: Plugin = (ctx: any) => {
  const manager = getPermissionManager(ctx)

  const dispose = ctx.provide('approval', {
    async request(request: { type: string; description: string; riskLevel: string; details?: any }): Promise<{ approved: boolean; reason?: string }> {
      return manager.requestApproval(request)
    },
    async respond(requestId: string, approved: boolean, reason?: string): Promise<void> {
      return manager.respondToApproval(requestId, approved, reason)
    },
    listPending(): any[] {
      return manager.listPendingApprovals()
    },
  })

  return dispose
}
