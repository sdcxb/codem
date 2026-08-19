// @ts-nocheck
/**
 * @codem/llm-mimo — MiMo LLM Provider 插件
 *
 * 独立注册 MiMo API Provider 到 ProviderRegistry。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册 mimo provider 到 llm 服务，AgenticLoop 可通过 ctx.get('llm') 调用
 * - 停止时：mimo provider 注销，ctx.get('llm') 返回的 ProviderRegistry 中无 mimo
 *   → complete() 抛出 "Provider not configured" 错误
 *   → RetryExecutor 尝试重试 → 仍然失败 → AgenticLoop 停止
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OpenAICompatibleProvider } from '../llm/provider'

export const llmMimoProvider: Plugin = (ctx: any) => {
  // 创建 MiMo Provider 实例
  const mimoProvider = new OpenAICompatibleProvider({
    id: 'mimo',
    name: 'MiMo',
    baseUrl: 'https://api.mimo.com/v1',
    apiKey: '', // 从 settings 加载
    models: [
      { id: 'mimo-v2.5-pro', name: 'MiMo v2.5 Pro', contextWindow: 128000 },
      { id: 'mimo-v2.5-lite', name: 'MiMo v2.5 Lite', contextWindow: 64000 },
      { id: 'mimo-auto', name: 'MiMo Auto (Free)', contextWindow: 32000 },
    ],
  })

  // 注册到 llm 服务的 ProviderRegistry
  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('mimo', mimoProvider)
  } else {
    // llm 服务不可用时，注册为独立服务
    ctx.provide('llmMimo', mimoProvider)
  }

  const dispose = () => {
    if (disposeProvider) disposeProvider()
  }

  return dispose
}
