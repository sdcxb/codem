// @ts-nocheck
/**
 * @codem/llm-pi-ai — Pi AI LLM Provider，Inflection Pi 模型适配器
 *
 * 创建 OpenAICompatibleProvider 实例并注册到 LLMEngine 的 ProviderRegistry。
 * 不委托给 ctx.get('llm')，避免无限递归。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OpenAICompatibleProvider } from '../llm/provider'

export const llmPiAiProvider: Plugin = (ctx: any) => {
  const piAiProvider = new OpenAICompatibleProvider({
    id: 'pi-ai',
    name: 'Pi AI',
    baseUrl: 'https://api.inflection.ai/v1',
    apiKey: '',
    models: [
      { id: 'pi-2', name: 'Pi 2', contextWindow: 8000 },
      { id: 'pi-2-mini', name: 'Pi 2 Mini', contextWindow: 4000 },
    ],
  })

  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('pi-ai', piAiProvider)
  } else {
    ctx.provide('llmPiAi', piAiProvider)
  }

  return () => {
    if (disposeProvider) disposeProvider()
  }
}
