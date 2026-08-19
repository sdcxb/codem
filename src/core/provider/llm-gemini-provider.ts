// @ts-nocheck
/**
 * @codem/llm-gemini — Gemini LLM Provider 插件
 *
 * Google Gemini 模型适配器，支持 Gemini 1.5 Pro / Flash。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册 gemini provider 到 llm 服务
 * - 停止时：gemini provider 注销
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OpenAICompatibleProvider } from '../llm/provider'

export const llmGeminiProvider: Plugin = (ctx: any) => {
  const geminiProvider = new OpenAICompatibleProvider({
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    models: [
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: 1000000 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1000000 },
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Experimental)', contextWindow: 1000000 },
    ],
  })

  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('gemini', geminiProvider)
  } else {
    ctx.provide('llmGemini', geminiProvider)
  }

  return () => { if (disposeProvider) disposeProvider() }
}
