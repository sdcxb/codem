// @ts-nocheck
/**
 * Agent Engine Provider 插件 — 包装真实 LLMEngine 并接入 ctx。
 *
 * 真实实现源：src/core/llm/index.ts（LLMEngine 类 + getLLMEngine()）
 *
 * 接入点：
 * - App.tsx 通过 ctx.get('agentEngine') 获取引擎实例
 * - 替代直接 import { getLLMEngine }
 *
 * 这是 Phase R4 的核心 — 让 LLMEngine 可通过 ctx 获取，
 * 第三方可通过注册更高优先级的 agentEngine Provider 来替换引擎。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { LLMEngine, getLLMEngine } from '../llm/index.ts'

export const agentEngineProvider: Plugin = (ctx: any) => {
  const engine = getLLMEngine()

  const dispose = ctx.provide('agentEngine', {
    async process(message: string, options?: any): Promise<any> {
      return engine.process(message, options)
    },
    getEngine(): LLMEngine {
      return engine
    },
  })

  return dispose
}
