// @ts-nocheck
/**
 * @codem/subagent-spawn-in-process — 进程内 Spawn 子 Agent 插件 (P1-7.8)
 *
 * 在当前进程中 Spawn 一个子 Agent，比 Fork 更轻量。
 *
 * 功能链路融入（文档 6.2 链路 D: 子 Agent 调度链）：
 * - 启动时：注册 spawn 模式子 Agent 工厂
 * - 停止时：spawn 模式不可用 → 回退到 fork 模式
 */
import type { Plugin } from '../cordis/src/index.ts'

class SpawnInProcessManager {
  private tasks: Map<string, any> = new Map()
  private ctx: any

  constructor(ctx: any) { this.ctx = ctx }

  async spawn(taskId: string, config: any): Promise<string> {
    const task = {
      id: taskId,
      agentId: config.agentId,
      status: 'running',
      config,
      startTime: Date.now(),
      result: null as any,
    }
    this.tasks.set(taskId, task)

    // Spawn: 更轻量的执行模式（无独立 AgenticLoop，直接调用 LLM）
    this.executeTask(task).catch(err => {
      task.status = 'failed'
      task.result = { error: err.message }
    })

    return taskId
  }

  private async executeTask(task: any) {
    try {
      const llm = this.ctx?.get('llm')
      if (!llm) throw new Error('LLM service not available')

      const response = await llm.complete({
        messages: [
          { role: 'system', content: task.config.systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: task.config.message },
        ],
        model: task.config.model || 'mimo-auto',
        maxTokens: task.config.maxTokens || 2048,
      })

      task.status = 'completed'
      task.result = { summary: response.content?.substring(0, 500) || '' }
    } catch (err: any) {
      task.status = 'failed'
      task.result = { error: err.message }
    }
  }

  getTask(taskId: string) { return this.tasks.get(taskId) }
  listTasks() { return Array.from(this.tasks.values()) }
  cancelTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (task) { task.status = 'cancelled'; }
  }
  clearTask(taskId: string) { this.tasks.delete(taskId) }
}

export const subagentSpawnInProcessProvider: Plugin = (ctx: any) => {
const manager = new SpawnInProcessManager(ctx)

  const dispose = ctx.provide('subagentSpawnInProcess', {
    async spawn(taskId: string, config: any) { return manager.spawn(taskId, config) },
    getTask(taskId: string) { return manager.getTask(taskId) },
    listTasks() { return manager.listTasks() },
    cancelTask(taskId: string) { return manager.cancelTask(taskId) },
    clearTask(taskId: string) { return manager.clearTask(taskId) },
  })

  return dispose
}
