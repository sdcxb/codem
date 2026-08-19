// @ts-nocheck
/**
 * @codem/llm-openai — OpenAI LLM Provider 插件
 *
 * 独立注册 OpenAI API Provider 到 ProviderRegistry。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册 openai provider，用户可在模型选择器中选择 GPT-4o 等模型
 * - 停止时：openai provider 注销，切换到 openai 模型的会话会报错
 *   → 用户需要切换回 mimo 或其他可用 provider
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OpenAICompatibleProvider } from '../llm/provider'

export const llmOpenAIProvider: Plugin = (ctx: any) => {
  const openaiProvider = new OpenAICompatibleProvider({
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '', // 从 settings 加载
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextWindow: 128000 },
    ],
  })

  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('openai', openaiProvider)
  } else {
    ctx.provide('llmOpenAI', openaiProvider)
  }

  return () => { if (disposeProvider) disposeProvider() }
}
