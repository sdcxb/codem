// @ts-nocheck
/**
 * @codem/subagent-in-process — 进程内子智能体 Provider
 *
 * DSH-style: 使用 SubagentRuntime 替代旧 SubagentManager
 * 对标 DSH ctx.subagents — 提供一致的 capability 接口
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { Subagent } from './index.ts'
import { getSubagentRuntime } from '../../subagent/index'

export class InProcessSubagent implements Subagent {
  constructor(private ctx: Context) {}

  async spawn(parentSessionId: string, agentId: string, prompt: string, cwd: string, abort?: AbortSignal) {
    const runtime = getSubagentRuntime()
    if (!runtime) throw new Error("SubagentRuntime not available")
    // DSH-style: startContinuable — 对标 DSH SubagentContinuationManager.startContinuable
    const result = await runtime.startContinuable({
      provider: 'spawn',
      label: agentId,
      request: {
        parentSessionId,
        agentId,
        prompt,
        cwd,
      },
      signal: abort ?? new AbortController().signal,
    })
    return { id: result.childId, name: agentId }
  }

  getTask(taskId: string) {
    const runtime = getSubagentRuntime()
    if (!runtime) return undefined
    return runtime.getTask(taskId)
  }

  async waitForTask(taskId: string, abort?: AbortSignal) {
    const runtime = getSubagentRuntime()
    if (!runtime) throw new Error("SubagentRuntime not available")
    // DSH-style: await executionDone — 对标 DSH SubagentRun.result
    // 不再轮询
    await runtime.waitForTask(taskId)
    return runtime.getTask(taskId)
  }
}

export const inject = [] as const
export const provide = ['subagents'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('subagents', new InProcessSubagent(ctx))
}
