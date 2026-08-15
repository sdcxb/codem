// @ts-nocheck
/**
 * @codem/subagent — 子智能体能力族 Service Definition
 *
 * 定义子智能体管理接口契约。Provider 包实现此接口。
 * 替代原有 seam/types.ts 中的 SubagentSeam。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface Subagent {
  spawn(parentSessionId: string, agentId: string, prompt: string, cwd: string, abort?: AbortSignal): Promise<{ id: string; name: string }>
  getTask(taskId: string): any
  waitForTask(taskId: string, abort?: AbortSignal): Promise<{ success: boolean; result?: string; error?: string }>
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** 子智能体服务（可替换 Provider） */
    subagents: Subagent
  }
}
