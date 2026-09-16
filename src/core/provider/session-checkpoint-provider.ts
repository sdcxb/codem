// @ts-nocheck
/**
 * @codem/session-checkpoint — 会话检查点策略插件
 *
 * 管理会话检查点的创建和恢复策略。可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 E: 会话恢复链）：
 * - 启动时：注册检查点策略，每轮迭代后自动创建检查点
 * - 停止时：检查点不创建，崩溃后无法回滚到中间状态
 *   → 文档 6.4 辅助链路: 会话恢复 | ⚠️ 无法恢复 | 不保存恢复点
 *
 * ⚠️ **第 86 波（诚实性修正）：这里的检查点是"进程内"的，不是持久化的。**
 * 原文案容易让人以为"启用后崩溃也能回滚"，实际 `checkpoints` 只是一个 Map：
 *   · 同一个进程内可以按迭代回看/恢复（这是它的真实能力）；
 *   · **进程退出/崩溃后全部丢失**（要跨重启恢复请用 `core/recovery/` 的会话恢复链，
 *     以及 SQLite/JSONL 里已经落盘的消息与快照）。
 * 现在把这一点写进文档，并在首次保存检查点时输出一次说明日志，避免误判可靠性。
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
  private seq = 0
  private warnedVolatile = false

  setPolicy(policy: Partial<CheckpointPolicy>) {
    this.policy = { ...this.policy, ...policy }
  }

  shouldCheckpoint(sessionId: string, iteration: number): boolean {
    return iteration > 0 && iteration % this.policy.interval === 0
  }

  /**
   * 保存一个检查点。
   *
   * 第 86 波：以前返回 void，且**如果调用方没在 state 里带 `id`，这个检查点就永远
   * 无法被 `restore(sessionId, checkpointId)` 找到**（因为 restore 按 `cp.id` 匹配）。
   * 现在缺 id 时自动生成并返回，保证"存了就能按 id 取回"。
   *
   * @returns 本次检查点的 id
   */
  saveCheckpoint(sessionId: string, state: any): string {
    if (!this.warnedVolatile) {
      this.warnedVolatile = true
      console.info(
        '[sessionCheckpoint] 检查点保存在内存中：同一次运行内可按迭代回看/恢复，进程退出后不再保留（跨重启恢复请依赖已落盘的消息/快照）。',
      )
    }
    if (!this.checkpoints.has(sessionId)) {
      this.checkpoints.set(sessionId, [])
    }
    const list = this.checkpoints.get(sessionId)!
    const id = (state && typeof state.id === 'string' && state.id) || `cp-${++this.seq}-${Date.now()}`
    list.push({ ...state, id, savedAt: Date.now() })

    if (this.policy.autoCleanup && list.length > this.policy.maxCheckpoints) {
      list.shift() // 移除最旧的
    }
    return id
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
    saveCheckpoint(sessionId: string, state: any) { return manager.saveCheckpoint(sessionId, state) },
    getCheckpoints(sessionId: string) { return manager.getCheckpoints(sessionId) },
    getLatest(sessionId: string) { return manager.getLatest(sessionId) },
    restore(sessionId: string, checkpointId: string) { return manager.restore(sessionId, checkpointId) },
    clear(sessionId?: string) { manager.clear(sessionId) },
  })

  return dispose
}
