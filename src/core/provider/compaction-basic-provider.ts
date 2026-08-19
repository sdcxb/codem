// @ts-nocheck
/**
 * @codem/compaction-basic — 基础压缩策略插件 (P1-7.9)
 *
 * 提供基于摘要的上下文压缩策略。
 *
 * 功能链路融入（文档 6.2 链路 C: 上下文压缩链）：
 * - 启动时：注册压缩策略，上下文超过阈值时自动触发
 * - 停止时：压缩不可用 → 上下文溢出直接停止
 *   → 文档 6.4 辅助链路: 上下文压缩 | ⚠️ 上下文溢出 | 直接停止
 */
import type { Plugin } from '../cordis/src/index.ts'

class CompactionBasic {
  private threshold: number = 80000 // 80K tokens
  private keepRecent: number = 10    // 保留最近 10 条消息
  private maxConsecutive: number = 3 // 最大连续压缩 3 次

  configure(config: Partial<{ threshold: number; keepRecent: number; maxConsecutive: number }>) {
    if (config.threshold !== undefined) this.threshold = config.threshold
    if (config.keepRecent !== undefined) this.keepRecent = config.keepRecent
    if (config.maxConsecutive !== undefined) this.maxConsecutive = config.maxConsecutive
  }

  shouldCompact(contextPressure: number, consecutiveCount: number): boolean {
    if (consecutiveCount >= this.maxConsecutive) return false
    return contextPressure > this.threshold
  }

  getKeepRecent() { return this.keepRecent }
  getMaxConsecutive() { return this.maxConsecutive }
  getThreshold() { return this.threshold }

  /**
   * 找到 API-Round 边界：保留最近 N 条消息，对齐到工具调用结束位置
   */
  findCompactionBoundary(messages: any[]): number {
    if (messages.length <= this.keepRecent) return -1 // 不需要压缩

    // 从 keepRecent 位置往前找，找到第一个工具调用结果之后的边界
    const startIdx = messages.length - this.keepRecent
    for (let i = startIdx; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'tool' || (msg.role === 'assistant' && msg.tool_calls)) {
        return i + 1 // 保留从 i+1 开始的消息
      }
    }
    return startIdx
  }
}

export const compactionBasicProvider: Plugin = (ctx: any) => {
  const strategy = new CompactionBasic()

  const dispose = ctx.provide('compactionBasic', {
    configure(config: any) { strategy.configure(config) },
    shouldCompact(contextPressure: number, consecutiveCount: number) { return strategy.shouldCompact(contextPressure, consecutiveCount) },
    getKeepRecent() { return strategy.getKeepRecent() },
    getMaxConsecutive() { return strategy.getMaxConsecutive() },
    getThreshold() { return strategy.getThreshold() },
    findCompactionBoundary(messages: any[]) { return strategy.findCompactionBoundary(messages) },
  })

  return dispose
}
