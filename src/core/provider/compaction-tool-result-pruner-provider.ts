// @ts-nocheck
/**
 * @codem/compaction-tool-result-pruner — 工具结果裁剪插件 (P1-7.9)
 *
 * 在压缩上下文时，裁剪过长的工具结果以减少 token 占用。
 *
 * 功能链路融入（文档 6.2 链路 C: 上下文压缩链）：
 * - 启动时：注册裁剪策略，压缩时自动裁剪工具结果
 * - 停止时：不裁剪，工具结果保留完整（消耗更多 token）
 */
import type { Plugin } from '../cordis/src/index.ts'

class ToolResultPruner {
  private maxInlineLength: number = 2000 // 工具结果保留前 2000 字符
  private maxToolResults: number = 5     // 最多保留 5 个工具结果

  configure(config: Partial<{ maxInlineLength: number; maxToolResults: number }>) {
    if (config.maxInlineLength !== undefined) this.maxInlineLength = config.maxInlineLength
    if (config.maxToolResults !== undefined) this.maxToolResults = config.maxToolResults
  }

  prune(result: string): string {
    if (result.length <= this.maxInlineLength) return result
    return result.substring(0, this.maxInlineLength) + '\n... [truncated by pruner]'
  }

  pruneMessages(messages: any[]): any[] {
    let toolResultCount = 0
    return messages.map(msg => {
      if (msg.role === 'tool') {
        toolResultCount++
        if (toolResultCount > this.maxToolResults) {
          return { ...msg, content: '[removed by pruner]' }
        }
        if (typeof msg.content === 'string' && msg.content.length > this.maxInlineLength) {
          return { ...msg, content: this.prune(msg.content) }
        }
      }
      return msg
    })
  }

  getMaxInlineLength() { return this.maxInlineLength }
  getMaxToolResults() { return this.maxToolResults }
}

export const compactionToolResultPrunerProvider: Plugin = (ctx: any) => {
  const pruner = new ToolResultPruner()

  const dispose = ctx.provide('compactionToolResultPruner', {
    configure(config: any) { pruner.configure(config) },
    prune(result: string) { return pruner.prune(result) },
    pruneMessages(messages: any[]) { return pruner.pruneMessages(messages) },
    getMaxInlineLength() { return pruner.getMaxInlineLength() },
    getMaxToolResults() { return pruner.getMaxToolResults() },
  })

  return dispose
}
