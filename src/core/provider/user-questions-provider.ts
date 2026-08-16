// @ts-nocheck
/**
 * User Questions Provider 插件 — 包装真实 Agent→Human 队列并接入 ctx。
 *
 * 真实实现源：src/core/llm/needs-you-queue.ts（126 行完整实现）
 * 支持：Agent→Human 方向队列 + SQLite 持久化 + 迭代边界消费
 *
 * 接入点：
 * - AgenticLoop 每次迭代结束时调用 ctx.userQuestions.drain() 消费待回答的问题
 * - UI 输入面板通过 ctx.userQuestions.respond() 提交回答
 * - LLM 工具 ask_user 通过 ctx.userQuestions.enqueue() 发起提问
 */
import type { Plugin } from '../cordis/src/index.ts'
import { NeedsYouQueue } from '../llm/needs-you-queue.ts'

export const userQuestionsProvider: Plugin = (ctx: any) => {
  const queue = new NeedsYouQueue(ctx)

  const dispose = ctx.provide('userQuestions', {
    async enqueue(question: { text: string; options?: string[]; sessionId?: string }): Promise<string> {
      return queue.enqueue(question)
    },
    async dequeue(): Promise<any> {
      return queue.dequeue()
    },
    async drain(): Promise<any[]> {
      return queue.drain()
    },
    async respond(questionId: string, answer: string): Promise<void> {
      return queue.respond(questionId, answer)
    },
    async listPending(sessionId?: string): Promise<any[]> {
      return queue.listPending(sessionId)
    },
  })

  return dispose
}
