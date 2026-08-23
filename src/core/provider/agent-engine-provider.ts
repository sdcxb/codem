// @ts-nocheck
/**
 * Agent Engine Provider 插件 — 包装真实 LLMEngine 并接入 ctx。
 *
 * 真实实现源：src/core/llm/index.ts（LLMEngine 类 + getLLMEngine()）
 *
 * 接入点：
 * - App.tsx 通过 ctx.get('llmEngine') 获取引擎实例（带配置）
 * - agentLoopProvider 通过 ctx.get('agentEngine') 获取引擎实例
 *
 * 此 Provider 不创建新实例——它从 ctx.get('llmEngine') 获取已由 App.tsx
 * 配置好的引擎实例，注册为 'agentEngine' 服务别名。
 * 这样所有消费者共享同一个配置好的引擎实例。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { LLMEngine } from '../llm/index.ts'

export const agentEngineProvider: Plugin = Object.assign(
  (ctx: any) => {
    // 不创建新实例——从 ctx 获取 App.tsx 已注册的 llmEngine
    const getEngineInstance = (): any => {
      const engine = ctx.get('llmEngine')
      if (engine) return engine
      // Fallback: create a new instance with ctx (should not normally happen)
      console.warn('[agentEngineProvider] llmEngine not available in ctx, creating fallback instance')
      return new LLMEngine({}, undefined, ctx)
    }

    const dispose = ctx.provide('agentEngine', {
      async process(message: string, options?: any): Promise<any> {
        const engine = getEngineInstance()
        return engine.process(message, options)
      },
      getEngine(): LLMEngine {
        return getEngineInstance()
      },
    })

    return dispose
  },
  { inject: ['llmEngine'] as const }
)
