// @ts-nocheck
/**
 * @codem/llm-retry — LLM 重试策略插件
 *
 * 独立注册 LLM 重试策略，可配置重试次数、退避策略等。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册重试策略，LLM 调用失败时自动重试
 * - 停止时：重试策略不可用，LLM 调用直接抛错
 *   → 连续错误超限 → AgenticLoop 停止
 *   → 文档 6.4 辅助链路: 重试 | ⚠️ 无重试 | 直接抛错
 */
import type { Plugin } from '../cordis/src/index.ts'
import { RetryExecutor, classifyError } from '../retry/retry'

export const llmRetryProvider: Plugin = (ctx: any) => {
  const executor = new RetryExecutor()

  const dispose = ctx.provide('llmRetry', {
    async execute<T>(fn: () => Promise<T>, onRetry?: (attempt: number, delay: number, error: unknown) => void): Promise<T> {
      return executor.execute(fn, onRetry)
    },
    classifyError(error: unknown) { return classifyError(error) },
    getConfig() { return executor.getConfig() },
  })

  return dispose
}
