// @ts-nocheck
/**
 * Cost Tracker Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 不创建独立实例，而是从 ctx.get('llmEngine') 获取
 * LLMEngine 实例的 CostTracker，确保共享同一个实例。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const costTrackerProvider: Plugin = Object.assign(
  (ctx: any) => {
    const engine = ctx.get('llmEngine')
    if (!engine?.costTracker) {
      console.warn('[costTrackerProvider] llmEngine not available')
      return () => {}
    }
    const dispose = ctx.provide('costTracker', engine.costTracker)
    return dispose
  },
  { inject: ['llmEngine'] as const }
)
