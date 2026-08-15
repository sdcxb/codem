// @ts-nocheck
/**
 * Approval Provider 插件 — 审批服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const approvalProvider: Plugin = (ctx: any) => {
  const pendingApprovals: any[] = []

  const dispose = ctx.provide('approval', {
    request: async (action: string, resource?: any) => {
      const id = crypto.randomUUID()
      return new Promise(resolve => {
        pendingApprovals.push({ id, action, resource, resolve })
      })
    },
    getPending: () => pendingApprovals.map(({ id, action, resource }) => ({ id, action, resource })),
    resolve: (id: string, approved: boolean, reason?: string) => {
      const idx = pendingApprovals.findIndex(p => p.id === id)
      if (idx >= 0) { pendingApprovals[idx].resolve({ approved, reason }); pendingApprovals.splice(idx, 1) }
    },
  })

  return dispose
}
