// @ts-nocheck
/**
 * @codem/subagent-fork-in-process — 进程内 Fork 子 Agent 插件 (P1-7.8)
 *
 * 在当前进程中 Fork 一个子 Agent，共享同一 Cordis Context。
 *
 * 功能链路融入（文档 6.2 链路 D: 子 Agent 调度链）：
 * - 启动时：注册 fork 模式子 Agent 工厂
 * - 停止时：fork 模式不可用 → 回退到 spawn 模式
 *   → 文档 6.4 辅助链路: 子 Agent 不可用 → spawn_subagent 返回错误
 */
import type { Plugin } from '../cordis/src/index.ts'

class ForkInProcessManager {
  private tasks: Map<string, any> = new Map()

  async fork(taskId: string, config: any): Promise<string> {
    const ctx = (globalThis as any).__codemCtx
    if (!ctx) throw new Error('Cordis Context not available')

    const agentRegistry = ctx.get('agentRegistry')
    const agent = agentRegistry?.get(config.agentId || 'general')
    if (!agent) throw new Error(`Agent "${config.agentId}" not found`)

    // Fork: 创建独立 AgenticLoop 实例（同进程内）
    const task = {
      id: taskId,
      agentId: config.agentId,
      status: 'running',
      config,
      startTime: Date.now(),
      result: null as any,
    }
    this.tasks.set(taskId, task)

    // 异步执行（不 await，让调用者通过 wait 获取结果）
    this.executeTask(task).catch(err => {
      task.status = 'failed'
      task.result = { error: err.message }
    })

    return taskId
  }

  private async executeTask(task: any) {
    try {
      const ctx = (globalThis as any).__codemCtx
      const agentEngine = ctx?.get('agentEngine')
      if (!agentEngine) throw new Error('AgentEngine not available')

      const events = agentEngine.process(
        task.config.sessionId || `fork-${task.id}`,
        task.config.message,
        task.config.cwd || '.',
        undefined,
        { agentId: task.agentId, collaborationMode: 'default' },
      )

      let finalResult = ''
      for await (const event of events) {
        if (event.type === 'text_delta') finalResult += event.text
        if (event.type === 'end') break
      }

      task.status = 'completed'
      task.result = { summary: finalResult.substring(0, 500) }
    } catch (err: any) {
      task.status = 'failed'
      task.result = { error: err.message }
    }
  }

  getTask(taskId: string) { return this.tasks.get(taskId) }
  listTasks() { return Array.from(this.tasks.values()) }
  clearTask(taskId: string) { this.tasks.delete(taskId) }
}

export const subagentForkInProcessProvider: Plugin = (ctx: any) => {
  const manager = new ForkInProcessManager()

  const dispose = ctx.provide('subagentForkInProcess', {
    async fork(taskId: string, config: any) { return manager.fork(taskId, config) },
    getTask(taskId: string) { return manager.getTask(taskId) },
    listTasks() { return manager.listTasks() },
    clearTask(taskId: string) { return manager.clearTask(taskId) },
  })

  return dispose
}
