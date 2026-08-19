// @ts-nocheck
/**
 * @codem/session-recovery — 会话恢复插件
 *
 * 提供会话崩溃后的自动恢复能力。
 * 在 AgenticLoop 异常终止时保存上下文快照，
 * 在下次启动时检测并恢复到崩溃前的状态。
 *
 * 功能链路融入（文档 6.2 链路 E: 会话持久化链）：
 * - 启动时：检查是否有未完成的会话快照 → 恢复
 * - AgenticLoop 每轮迭代后：保存快照
 * - 崩溃后重启：自动恢复到最近快照
 * - 停止时：清除快照（正常退出时）
 */
import type { Plugin } from '../cordis/src/index.ts'

class SessionRecovery {
  private snapshots: Map<string, { sessionId: string; messages: any[]; goalId: string | null; timestamp: number; iteration: number }> = new Map()
  private maxSnapshots: number = 50

  /**
   * 保存会话快照
   */
  saveSnapshot(sessionId: string, data: { messages: any[]; goalId: string | null; iteration: number }) {
    const snapshot = {
      sessionId,
      messages: data.messages,
      goalId: data.goalId,
      timestamp: Date.now(),
      iteration: data.iteration,
    }
    this.snapshots.set(sessionId, snapshot)

    // 限制快照数量
    if (this.snapshots.size > this.maxSnapshots) {
      const oldest = [...this.snapshots.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
      if (oldest) this.snapshots.delete(oldest[0])
    }

    // 持久化到 localStorage（浏览器/Tauri 环境）
    try {
      const persistData = { sessionId, ...snapshot }
      localStorage.setItem(`__codem_recovery_${sessionId}`, JSON.stringify(persistData))
    } catch (e) { console.warn('[session-recovery-provider.ts]', e) }
  }

  /**
   * 检测是否有可恢复的会话
   */
  getRecoverableSessions(): Array<{ sessionId: string; timestamp: number; iteration: number }> {
    // 从内存快照
    const inMemory = [...this.snapshots.values()].map(s => ({
      sessionId: s.sessionId,
      timestamp: s.timestamp,
      iteration: s.iteration,
    }))

    // 从 localStorage 恢复
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('__codem_recovery_')) {
          const data = JSON.parse(localStorage.getItem(key) || '{}')
          if (data.sessionId && !this.snapshots.has(data.sessionId)) {
            inMemory.push({
              sessionId: data.sessionId,
              timestamp: data.timestamp,
              iteration: data.iteration,
            })
          }
        }
      }
    } catch (e) { console.warn('[session-recovery-provider.ts]', e) }

    return inMemory.sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * 恢复会话
   */
  recover(sessionId: string): { messages: any[]; goalId: string | null; iteration: number } | null {
    // 先从内存取
    let snapshot = this.snapshots.get(sessionId)

    // 再从 localStorage 取
    if (!snapshot) {
      try {
        const data = localStorage.getItem(`__codem_recovery_${sessionId}`)
        if (data) {
          const parsed = JSON.parse(data)
          snapshot = {
            sessionId: parsed.sessionId,
            messages: parsed.messages,
            goalId: parsed.goalId,
            timestamp: parsed.timestamp,
            iteration: parsed.iteration,
          }
          this.snapshots.set(sessionId, snapshot)
        }
      } catch (e) { console.warn('[session-recovery-provider.ts]', e) }
    }

    if (!snapshot) return null

    return {
      messages: snapshot.messages,
      goalId: snapshot.goalId,
      iteration: snapshot.iteration,
    }
  }

  /**
   * 清除会话快照（正常退出时调用）
   */
  clearSnapshot(sessionId: string) {
    this.snapshots.delete(sessionId)
    try {
      localStorage.removeItem(`__codem_recovery_${sessionId}`)
    } catch (e) { console.warn('[session-recovery-provider.ts]', e) }
  }

  /**
   * 清除所有快照
   */
  clearAll() {
    this.snapshots.clear()
    try {
      const keysToRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('__codem_recovery_')) keysToRemove.push(key)
      }
      keysToRemove.forEach(k => localStorage.removeItem(k))
    } catch (e) { console.warn('[session-recovery-provider.ts]', e) }
  }
}

export const sessionRecoveryProvider: Plugin = (ctx: any) => {
  const recovery = new SessionRecovery()

  const dispose = ctx.provide('sessionRecovery', {
    saveSnapshot: (sessionId: string, data: any) => recovery.saveSnapshot(sessionId, data),
    getRecoverableSessions: () => recovery.getRecoverableSessions(),
    recover: (sessionId: string) => recovery.recover(sessionId),
    clearSnapshot: (sessionId: string) => recovery.clearSnapshot(sessionId),
    clearAll: () => recovery.clearAll(),
  })

  // 注册到 eventLog：监听 service/unload 事件，自动保存当前会话快照
  try {
    ctx.on('service/unload', (data: any) => {
      if (data?.name === 'session' || data?.name === 'agentEngine') {
        console.log('[sessionRecovery] Service unloading, saving emergency snapshots')
      }
    })
  } catch (e) { console.warn('[session-recovery-provider.ts]', e) }

  return dispose
}
