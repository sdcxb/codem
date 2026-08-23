// @ts-nocheck
/**
 * Retry Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 不创建独立实例，而是从 ctx.get('llmEngine') 获取
 * LLMEngine 实例的 RetryExecutor，确保共享同一个实例。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { classifyError } from '../retry/retry'

export const retryProvider: Plugin = Object.assign(
  (ctx: any) => {
    const engine = ctx.get('llmEngine')
    if (!engine?.retry) {
      console.warn('[retryProvider] llmEngine not available')
      return () => {}
    }
    const executor = engine.retry

    const dispose = ctx.provide('retry', {
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
