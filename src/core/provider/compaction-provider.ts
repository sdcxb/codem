// @ts-nocheck
/**
 * Compaction Provider 插件 — 包装真实上下文压缩实现并接入 ctx。
 *
 * 真实实现源：
 * - src/core/context/context.ts（ContextManager 类）
 * - src/core/llm/micro-compact.ts（253 行完整实现：两级压缩策略）
 *
 * 接入点：
 * - AgenticLoop 迭代前检查 ctx.compaction.shouldCompact()
 * - 超过 token 阈值时调用 ctx.compaction.compact() 压缩上下文
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ContextManager } from '../context/context.ts'

export const compactionProvider: Plugin = (ctx: any) => {
  const manager = new ContextManager(ctx)

  const dispose = ctx.provide('compaction', {
    shouldCompact(messages: any[]): boolean {
      return manager.shouldCompact(messages)
    },
    async compact(messages: any[], options?: { preserveRecent?: number }): Promise<any[]> {
      return manager.compact(messages, options)
    },
    estimateTokens(text: string): number {
      return manager.estimateTokens(text)
    },
    getTokenLimit(): number {
      return manager.getTokenLimit()
    },
  })

  return dispose
}
