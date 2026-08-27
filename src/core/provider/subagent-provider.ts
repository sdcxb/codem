// @ts-nocheck
/**
 * Subagent Provider 插件 — 可独立加载/卸载/热替换。
 *
 * DSH-style: 向 Cordis ctx 注册 SubagentRuntime。
 * 对标 DSH ctx.provide('subagents', runtime)
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSubagentRuntime } from '../subagent/index'

export const subagentProvider: Plugin = Object.assign(
  (ctx: any) => {
    const runtime = getSubagentRuntime()
    if (!runtime) {
      console.warn('[subagentProvider] SubagentRuntime not available')
      return () => {}
    }

    // DSH-style: 暴露 SubagentRuntime 实例
    const dispose = ctx.provide('subagent', runtime)

    return dispose
  },
  { inject: [] as const }
)
