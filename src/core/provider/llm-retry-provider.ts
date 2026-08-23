// @ts-nocheck
/**
 * @codem/llm-retry — LLM 重试策略插件
 *
 * 共享 LLMEngine 的 RetryExecutor，不创建独立实例。
 * 注册为 'llmRetry' 服务（与 'retry' 是不同的服务名，但共享同一个实例）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { classifyError } from '../retry/retry'

export const llmRetryProvider: Plugin = Object.assign(
  (ctx: any) => {
    const engine = ctx.get('llmEngine')
    if (!engine?.retry) {
      console.warn('[llmRetryProvider] llmEngine not available')
      return () => {}
    }
    const executor = engine.retry

    const dispose = ctx.provide('llmRetry', {
      async execute<T>(fn: () => Promise<T>, onRetry?: (attempt: number, delay: number, error: unknown) => void): Promise<T> {
        return executor.execute(fn, onRetry)
      },
      classifyError(error: unknown) { return classifyError(error) },
      getConfig() { return executor.getConfig() },
    })

    return dispose
  },
  { inject: ['llmEngine'] as const }
)
