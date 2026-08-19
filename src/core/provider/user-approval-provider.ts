// @ts-nocheck
/**
 * @codem/user-approval — 用户审批流程，关键操作的完整审批工作流
 */
import type { Plugin } from '../cordis/src/index.ts'

export const userApprovalProvider: Plugin = (ctx: any) => {
  const s = {
    pending: new Map(),
    async request(action, opts={}) { const id='approval-'+Date.now(); const req={id,action,opts,status:'pending',createdAt:Date.now()}; this.pending.set(id,req); return req },
    async approve(id, comment) { const req=this.pending.get(id); if(req){req.status='approved'; req.comment=comment; req.resolvedAt=Date.now(); this.pending.delete(id); return req} throw new Error('Approval request not found') },
    async reject(id, comment) { const req=this.pending.get(id); if(req){req.status='rejected'; req.comment=comment; req.resolvedAt=Date.now(); this.pending.delete(id); return req} throw new Error('Approval request not found') },
    getPending() { return [...this.pending.values()] },
  }
  return ctx.provide('userApproval', s)
}
