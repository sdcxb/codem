// @ts-nocheck
/**
 * Subagent Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { SubagentManager } from '../subagent/subagent'

export const subagentProvider: Plugin = (ctx: any) => {
  // 在 Provider 内部创建实例，生命周期与 fiber 绑定
  const subagentMgr = new SubagentManager()

  const dispose = ctx.provide('subagent', {
    spawn: async (task: any) => {
      // 委托给具体策略插件（如果可用）
      try {
        const spawnStrategy = ctx.get('subagentSpawnInProcess')
        if (spawnStrategy) return await spawnStrategy.spawn(task.id || crypto.randomUUID(), task)
      } catch (e) { console.warn('[subagent-provider.ts]', e) }
      try {
        const forkStrategy = ctx.get('subagentForkInProcess')
        if (forkStrategy) return await forkStrategy.fork(task)
      } catch (e) { console.warn('[subagent-provider.ts]', e) }
      // 默认实现
      return subagentMgr.spawn(task)
    },
    list: () => subagentMgr.list(),
    getResult: (id: string) => subagentMgr.getResult(id),
    kill: (id: string) => subagentMgr.kill(id),
  })

  return dispose
}
