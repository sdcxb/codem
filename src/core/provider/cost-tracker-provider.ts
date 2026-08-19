// @ts-nocheck
/**
 * Cost Tracker Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 CostTracker 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getCostTracker()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { CostTracker } from '../llm/cost-tracker'

export const costTrackerProvider: Plugin = (ctx: any) => {
  const tracker = new CostTracker()

  const dispose = ctx.provide('costTracker', {
    recordUsage(sessionId: string, usage: any) { tracker.recordUsage(sessionId, usage) },
    getSessionCost(sessionId: string) { return tracker.getSessionCost(sessionId) },
    getTotalCost() { return tracker.getTotalCost() },
    reset(sessionId?: string) { tracker.reset(sessionId) },
    exportReport() { return tracker.exportReport() },
  })

  return dispose
}
