// @ts-nocheck
/**
 * Subagent Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSubagentManager } from '../subagent/subagent'

export const subagentProvider: Plugin = (ctx: any) => {
  const subagentMgr = getSubagentManager()

  const dispose = ctx.provide('subagent', {
    spawn: async (task: any) => subagentMgr.spawn(task),
    list: () => subagentMgr.list(),
    getResult: (id: string) => subagentMgr.getResult(id),
    kill: (id: string) => subagentMgr.kill(id),
  })

  return dispose
}
