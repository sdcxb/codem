// @ts-nocheck
/**
 * @codem/subagent-in-process — 进程内子智能体 Provider
 *
 * 在当前进程中运行子智能体。
 * 包装现有 subagent/ 下的实现。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { Subagent } from './index.ts'
import { getSubagentManager } from '../../subagent/subagent'

export class InProcessSubagent implements Subagent {
  constructor(private ctx: Context) {}

  async spawn(parentSessionId: string, agentId: string, prompt: string, cwd: string, abort?: AbortSignal) {
    const mgr = getSubagentManager()
    const task = await mgr.spawn({ parentSessionId, agentId, prompt, cwd, abort } as any)
    return { id: task.id, name: task.name }
  }

  getTask(taskId: string) {
    const mgr = getSubagentManager()
    return mgr.getResult(taskId)
  }

  async waitForTask(taskId: string, abort?: AbortSignal) {
    const mgr = getSubagentManager()
    return mgr.waitForTask(taskId, abort)
  }
}

export const inject = [] as const
export const provide = ['subagents'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('subagents', new InProcessSubagent(ctx))
}
