// @ts-nocheck
/**
 * LLM Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 不创建独立的 ProviderRegistry，而是从 ctx.get('llmEngine') 获取
 * LLMEngine 实例的 ProviderRegistry，确保所有 LLM 调用路径共享同一个 registry。
 *
 * 第三方插件可以通过 llm.registerProvider(id, provider) 注册额外的 LLM Provider。
 * 返回一个 dispose 函数，调用后注销该 provider。
 *
 * 加载顺序保证：
 * - App.tsx 在 ctx 初始化时立即注册 llmEngine 服务（第 101 行）
 * - llmProvider 通过 inject: ['llmEngine'] 声明依赖，Cordis 保证 llmEngine 就绪后才加载
 * - llm-*-provider 通过 inject: ['llm'] 声明依赖，保证 llm 服务就绪后才加载
 */
import type { Plugin } from '../cordis/src/index.ts'

export const llmProvider: Plugin = Object.assign(
  (ctx: any) => {
    /** 获取 LLMEngine 实例的 ProviderRegistry */
    const getRegistry = () => {
      const engine = ctx.get('llmEngine')
      if (engine?.providers) return engine.providers
      console.warn('[llmProvider] llmEngine not available, LLM calls will fail')
      return null
    }

    /** 动态注册的 provider 的 dispose 函数映射 */
    const dynamicDisposers = new Map<string, () => void>()

    const dispose = ctx.provide('llm', {
      complete: async (request: any) => {
        const registry = getRegistry()
        if (!registry) throw new Error('LLM engine not available')
        const providerId = request.provider || 'mimo'
        const provider = registry.get(providerId)
        if (!provider) throw new Error(`Provider "${providerId}" not registered`)
        // 确保 request 有 model 字段（LLMRequest 接口要求）
        if (!request.model) {
          const engine = ctx.get('llmEngine')
          request.model = engine?.getDefaultModel?.() || 'auto'
        }
        return provider?.complete(request)
      },
      stream: async function* (request: any) {
        const registry = getRegistry()
        if (!registry) throw new Error('LLM engine not available')
        const providerId = request.provider || 'mimo'
        const provider = registry.get(providerId)
        if (!provider) throw new Error(`Provider "${providerId}" not registered`)
        // 确保 request 有 model 字段（LLMRequest 接口要求）
        if (!request.model) {
          const engine = ctx.get('llmEngine')
          request.model = engine?.getDefaultModel?.() || 'auto'
        }
        if (provider) {
          yield* provider.stream(request)
        }
      },
      listModels: async () => {
        const registry = getRegistry()
        if (!registry) return []
        const allModels: any[] = []
        for (const provider of registry.getAll()) {
          allModels.push(...(await provider.listModels()))
        }
        return allModels
      },
      isConfigured: () => {
        const registry = getRegistry()
        if (!registry) return false
        return registry.getConfigured().length > 0
      },

      /**
       * 注册一个额外的 LLM Provider 到 LLMEngine 的 ProviderRegistry。
       * 用于 llm-mimo / llm-openai / llm-deepseek 等适配器插件。
       * 返回 dispose 函数，调用后注销该 provider。
       */
      registerProvider(id: string, provider: any): () => void {
        const registry = getRegistry()
        if (!registry) {
          console.warn(`[llmProvider] Cannot register "${id}": llmEngine not available`)
          return () => {}
        }

        // 如果已存在同 id 的 provider，先注销旧的动态注册
        const existingDispose = dynamicDisposers.get(id)
        if (existingDispose) existingDispose()

        registry.register(provider)
        console.log(`[llmProvider] Registered provider: ${id}`)

        const disposeFn = () => {
          registry.remove?.(id)
          dynamicDisposers.delete(id)
          console.log(`[llmProvider] Unregistered provider: ${id}`)
        }
        dynamicDisposers.set(id, disposeFn)
        return disposeFn
      },

      /** 获取指定 id 的 provider */
      getProvider(id: string) {
        const registry = getRegistry()
        return registry?.get(id)
      },

      /** 获取所有已注册的 provider */
      getAllProviders() {
        const registry = getRegistry()
        return registry?.getAll() || []
      },
    })

    return () => {
      // 注销所有动态注册的 provider
      for (const disp of dynamicDisposers.values()) {
        try { disp() } catch (e) { console.warn('[llmProvider] dispose error:', e) }
      }
      dynamicDisposers.clear()
      if (dispose) dispose()
    }
  },
  { inject: ['llmEngine'] as const }
)
