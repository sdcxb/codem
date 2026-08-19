// @ts-nocheck
/**
 * Streaming Executor Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 StreamingToolExecutorImpl 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getStreamingToolExecutor()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { StreamingToolExecutorImpl } from '../llm/streaming-executor'

export const streamingExecutorProvider: Plugin = (ctx: any) => {
  const executor = new StreamingToolExecutorImpl()

  const dispose = ctx.provide('streamingExecutor', {
    async *execute(toolCalls: any[], execCtx: any, handler: any) {
      return yield* executor.execute(toolCalls, execCtx, handler)
    },
    getConfig() { return executor.config },
    updateConfig(config: any) { executor.config = { ...executor.config, ...config } },
  })

  return dispose
}
