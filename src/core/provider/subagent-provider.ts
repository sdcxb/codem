// @ts-nocheck
/**
 * Subagent Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 不创建独立实例，而是从 ctx.get('llmEngine') 获取
 * LLMEngine 实例的 SubagentManager，确保共享同一个实例。
 * 策略委托通过 setSpawner 机制注入。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const subagentProvider: Plugin = Object.assign(
  (ctx: any) => {
    const engine = ctx.get('llmEngine')
    if (!engine?.subagents) {
      console.warn('[subagentProvider] llmEngine not available')
      return () => {}
    }
    const subagentMgr = engine.subagents

    // 尝试注入策略插件（如果可用）
    try {
      const spawnStrategy = ctx.get('subagentSpawnInProcess')
      if (spawnStrategy) {
        subagentMgr.setSpawner({
          spawn: (task: any) => spawnStrategy.spawn(task.id || crypto.randomUUID(), task),
          cancel: async (id: string) => { /* delegated */ },
          cancelAll: () => { /* delegated */ },
          getStatus: (id: string) => subagentMgr.getStatus(id),
          getResult: (id: string) => subagentMgr.getResult(id),
        })
      }
    } catch (e) { console.warn('[subagent-provider.ts] spawn strategy:', e) }

    // 直接暴露 SubagentManager 实例
    const dispose = ctx.provide('subagent', subagentMgr)

    return dispose
  },
  { inject: ['llmEngine'] as const }
)
