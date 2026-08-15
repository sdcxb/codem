// @ts-nocheck
/**
 * LLM Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 第三方插件可以注册更高优先级的 LLM Provider 来替换默认实现。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ProviderRegistry, createDefaultProviders } from '../llm/provider'

export const llmProvider: Plugin = (ctx: any) => {
  const providers = createDefaultProviders()

  const dispose = ctx.provide('llm', {
    complete: async (request: any) => {
      const provider = providers.get(request.provider || 'mimo')
      return provider?.complete(request)
    },
    stream: async function* (request: any) {
      const provider = providers.get(request.provider || 'mimo')
      if (provider) {
        yield* provider.stream(request)
      }
    },
    listModels: async () => {
      const allModels: any[] = []
      for (const provider of providers.values()) {
        allModels.push(...(await provider.listModels()))
      }
      return allModels
    },
    isConfigured: () => true,
  })

  return dispose
}
