// @ts-nocheck
/**
 * @codem/session-stats — 会话统计插件
 *
 * 提供会话级别的统计数据：消息数、Token 用量、工具调用数等。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册统计服务，每轮迭代后更新统计数据
 * - 停止时：统计不可用，不影响主流程（非关键）
 */
import type { Plugin } from '../cordis/src/index.ts'

class SessionStats {
  private stats: Map<string, any> = new Map()

  init(sessionId: string) {
    this.stats.set(sessionId, {
      messageCount: 0,
      toolCalls: 0,
      iterations: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    })
  }

  recordMessage(sessionId: string) {
    const s = this.stats.get(sessionId)
    if (s) s.messageCount++
  }

  recordToolCall(sessionId: string) {
    const s = this.stats.get(sessionId)
    if (s) s.toolCalls++
  }

  recordIteration(sessionId: string) {
    const s = this.stats.get(sessionId)
    if (s) s.iterations++
  }

  recordTokens(sessionId: string, tokens: number) {
    const s = this.stats.get(sessionId)
    if (s) s.totalTokens += tokens
  }

  getStats(sessionId: string) {
    return this.stats.get(sessionId)
  }

  getAllStats() {
    return Array.from(this.stats.entries()).map(([id, s]) => ({ sessionId: id, ...s }))
  }

  reset(sessionId: string) {
    this.init(sessionId)
  }

  remove(sessionId: string) {
    this.stats.delete(sessionId)
  }
}

export const sessionStatsProvider: Plugin = (ctx: any) => {
  const stats = new SessionStats()

  const dispose = ctx.provide('sessionStats', {
    init(sessionId: string) { stats.init(sessionId) },
    recordMessage(sessionId: string) { stats.recordMessage(sessionId) },
    recordToolCall(sessionId: string) { stats.recordToolCall(sessionId) },
    recordIteration(sessionId: string) { stats.recordIteration(sessionId) },
    recordTokens(sessionId: string, tokens: number) { stats.recordTokens(sessionId, tokens) },
    getStats(sessionId: string) { return stats.getStats(sessionId) },
    getAllStats() { return stats.getAllStats() },
    reset(sessionId: string) { stats.reset(sessionId) },
    remove(sessionId: string) { stats.remove(sessionId) },
  })

  return dispose
}
