// @ts-nocheck
/**
 * @codem/tool-subagent-control — 子 Agent 控制工具插件 (P1-7.8)
 *
 * 提供子 Agent 的控制接口：暂停、恢复、取消、查询状态。
 *
 * 功能链路融入（文档 6.2 链路 D: 子 Agent 调度链）：
 * - 启动时：注册控制服务，AgenticLoop 可管理子 Agent
 * - 停止时：控制接口不可用，子 Agent 继续运行但无法被控制
 */
import type { Plugin } from '../cordis/src/index.ts'

class SubagentControlManager {
  private controllers: Map<string, { status: string; pauseResolve?: () => void }> = new Map()

  register(taskId: string) {
    this.controllers.set(taskId, { status: 'running' })
  }

  pause(taskId: string): boolean {
    const ctrl = this.controllers.get(taskId)
    if (!ctrl || ctrl.status !== 'running') return false
    ctrl.status = 'paused'
    return true
  }

  resume(taskId: string): boolean {
    const ctrl = this.controllers.get(taskId)
    if (!ctrl || ctrl.status !== 'paused') return false
    ctrl.status = 'running'
    if (ctrl.pauseResolve) {
      ctrl.pauseResolve()
      ctrl.pauseResolve = undefined
    }
    return true
  }

  cancel(taskId: string): boolean {
    const ctrl = this.controllers.get(taskId)
    if (!ctrl) return false
    ctrl.status = 'cancelled'
    return true
  }

  getStatus(taskId: string): string | null {
    return this.controllers.get(taskId)?.status || null
  }

  async waitForResume(taskId: string): Promise<void> {
    const ctrl = this.controllers.get(taskId)
    if (!ctrl || ctrl.status !== 'paused') return
    return new Promise<void>((resolve) => {
      ctrl.pauseResolve = resolve
    })
  }

  unregister(taskId: string) {
    this.controllers.delete(taskId)
  }
}

export const toolSubagentControlProvider: Plugin = (ctx: any) => {
  const manager = new SubagentControlManager()

  const dispose = ctx.provide('subagentControl', {
    register(taskId: string) { manager.register(taskId) },
    pause(taskId: string) { return manager.pause(taskId) },
    resume(taskId: string) { return manager.resume(taskId) },
    cancel(taskId: string) { return manager.cancel(taskId) },
    getStatus(taskId: string) { return manager.getStatus(taskId) },
    async waitForResume(taskId: string) { return manager.waitForResume(taskId) },
    unregister(taskId: string) { return manager.unregister(taskId) },
  })

  return dispose
}
