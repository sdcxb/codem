// @ts-nocheck
/**
 * Compaction Provider 插件 — 包装真实上下文压缩实现并接入 ctx。
 *
 * 真实实现源：
 * - src/core/context/context.ts（ContextManager 类）
 * - src/core/llm/micro-compact.ts（253 行完整实现：两级压缩策略）
 *
 * 接入点：
 * - AgenticLoop 迭代前检查 ctx.compaction.needsCompaction(messages)
 * - 超过 token 阈值时调用 ctx.compaction.compact(messages) 压缩上下文（返回**同步**结果，用 await 也安全）
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ContextManager } from '../context/context.ts'

export const compactionProvider: Plugin = (ctx: any) => {
  const manager = new ContextManager(ctx)

  /**
   * ★ 全量审计（第三轮·中）：**只暴露真实存在的方法** ——
   * 被守的缺陷：这里原来暴露 `shouldCompact` / `estimateTokens(text)` / `getTokenLimit`，
   * 而 ContextManager 上根本没有这三个（只有 `needsCompaction(messages)`、
   * `estimateTokens(messages[])`、`compact(messages)`、`getConfig()`）⇒
   * 循环只做存在性检查 ⇒ 服务「在」、一调就 TypeError（本仓自己的教训：一个永远不生效的接口比没有它更糟）。
   */
  const dispose = ctx.provide('compaction', {
    /** 是否该压缩（真实口径在 ContextManager.needsCompaction） */
    needsCompaction(messages: any[]): boolean {
      return manager.needsCompaction(messages)
    },
    /** 压缩（ContextManager.compact 只收 messages；保留最近几轮由它自己的配置决定） */
    async compact(messages: any[]): Promise<any[]> {
      return manager.compact(messages)
    },
    /** 估算 token（ContextManager 的签名是**消息数组**，不是一段文本） */
    estimateTokens(messages: any[]): number {
      return manager.estimateTokens(messages)
    },
    /** 上下文窗口上限（真值来自它的配置，不再自造 getTokenLimit） */
    getContextWindow(): number {
      return manager.getConfig().maxContextWindow
    },
  })

  return dispose
}
