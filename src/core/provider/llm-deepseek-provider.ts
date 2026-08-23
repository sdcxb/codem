// @ts-nocheck
/**
 * @codem/llm-deepseek — DeepSeek 原生 API Provider
 *
 * 创建 OpenAICompatibleProvider 实例并注册到 LLMEngine 的 ProviderRegistry。
 * 不委托给 ctx.get('llm')，避免无限递归。
 * DeepSeek API 兼容 OpenAI 协议（/v1/chat/completions）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OpenAICompatibleProvider } from '../llm/provider'

export const llmDeepseekProvider: Plugin = (ctx: any) => {
  const deepseekProvider = new OpenAICompatibleProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '', // 从 settings 加载
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000 },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', contextWindow: 64000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek V3', contextWindow: 64000 },
    ],
  })

  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('deepseek', deepseekProvider)
  } else {
    ctx.provide('llmDeepseek', deepseekProvider)
  }

  return () => {
    if (disposeProvider) disposeProvider()
  }
}
