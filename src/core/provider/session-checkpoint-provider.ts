// @ts-nocheck
/**
 * @codem/session-checkpoint — 会话检查点策略插件
 *
 * 管理会话检查点的创建和恢复策略。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 E: 会话恢复链）：
 * - 启动时：注册检查点策略，每轮迭代后自动创建检查点
 * - 停止时：检查点不创建，崩溃后无法回滚到中间状态
 *   → 文档 6.4 辅助链路: 会话恢复 | ⚠️ 无法恢复 | 不保存恢复点
 */
import type { Plugin } from '../cordis/src/index.ts'

interface CheckpointPolicy {
  interval: number  // 每隔 N 次迭代创建检查点
  maxCheckpoints: number  // 最大保留检查点数
  autoCleanup: boolean  // 自动清理旧检查点
}

class SessionCheckpointManager {
  private policy: CheckpointPolicy = { interval: 5, maxCheckpoints: 10, autoCleanup: true }
  private checkpoints: Map<string, any[]> = new Map()

  setPolicy(policy: Partial<CheckpointPolicy>) {
    this.policy = { ...this.policy, ...policy }
  }

  shouldCheckpoint(sessionId: string, iteration: number): boolean {
    return iteration > 0 && iteration % this.policy.interval === 0
  }

  saveCheckpoint(sessionId: string, state: any) {
    if (!this.checkpoints.has(sessionId)) {
      this.checkpoints.set(sessionId, [])
    }
    const list = this.checkpoints.get(sessionId)!
    list.push({ ...state, savedAt: Date.now() })

    if (this.policy.autoCleanup && list.length > this.policy.maxCheckpoints) {
      list.shift() // 移除最旧的
    }
  }

  getCheckpoints(sessionId: string): any[] {
    return this.checkpoints.get(sessionId) || []
  }

  getLatest(sessionId: string): any | null {
    const list = this.checkpoints.get(sessionId)
    if (!list || list.length === 0) return null
    return list[list.length - 1]
  }

  restore(sessionId: string, checkpointId: string): any | null {
    const list = this.checkpoints.get(sessionId)
    if (!list) return null
    return list.find(cp => cp.id === checkpointId) || null
  }

  clear(sessionId?: string) {
    if (sessionId) {
      this.checkpoints.delete(sessionId)
    } else {
      this.checkpoints.clear()
    }
  }
}

export const sessionCheckpointProvider: Plugin = (ctx: any) => {
  const manager = new SessionCheckpointManager()

  const dispose = ctx.provide('sessionCheckpoint', {
    setPolicy(policy: Partial<CheckpointPolicy>) { manager.setPolicy(policy) },
    shouldCheckpoint(sessionId: string, iteration: number) { return manager.shouldCheckpoint(sessionId, iteration) },
    saveCheckpoint(sessionId: string, state: any) { manager.saveCheckpoint(sessionId, state) },
    getCheckpoints(sessionId: string) { return manager.getCheckpoints(sessionId) },
    getLatest(sessionId: string) { return manager.getLatest(sessionId) },
    restore(sessionId: string, checkpointId: string) { return manager.restore(sessionId, checkpointId) },
    clear(sessionId?: string) { manager.clear(sessionId) },
  })

  return dispose
}
