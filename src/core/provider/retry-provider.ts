// @ts-nocheck
/**
 * Retry Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 RetryExecutor 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getRetryExecutor()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { RetryExecutor, classifyError } from '../retry/retry'

export const retryProvider: Plugin = (ctx: any) => {
  const executor = new RetryExecutor()

  const dispose = ctx.provide('retry', {
    async execute<T>(fn: () => Promise<T>, onRetry?: (attempt: number, delay: number, error: unknown) => void): Promise<T> {
      return executor.execute(fn, onRetry)
    },
    classifyError(error: unknown) { return classifyError(error) },
    getConfig() { return executor.getConfig() },
  })

  return dispose
}
