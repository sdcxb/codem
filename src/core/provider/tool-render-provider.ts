// @ts-nocheck
/**
 * Tool Render Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 不创建独立的 ToolRenderRegistry，而是从 ctx.get('llmEngine') 获取
 * LLMEngine 实例的 ToolRenderRegistry，确保所有工具渲染器注册共享同一个 registry。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const toolRenderProvider: Plugin = Object.assign(
  (ctx: any) => {
    /** 获取 LLMEngine 实例的 ToolRenderRegistry */
    const getRegistry = () => {
      const engine = ctx.get('llmEngine')
      if (engine?.toolRenderer) return engine.toolRenderer
      console.warn('[toolRenderProvider] llmEngine not available, tool rendering will fail')
      return null
    }

    const dispose = ctx.provide('toolRender', {
      register: (toolName: string, renderer: any) => {
        const registry = getRegistry()
        if (!registry) {
          console.warn('[toolRenderProvider] Cannot register renderer: llmEngine not available')
          return
        }
        registry.register(toolName, renderer)
      },
      get: (toolName: string) => {
        const registry = getRegistry()
        return registry?.get(toolName)
      },
      getDefault: () => {
        const registry = getRegistry()
        return registry?.getDefault()
      },
      setDefault: (renderer: any) => {
        const registry = getRegistry()
        if (registry) registry.setDefault(renderer)
      },
    })

    return dispose
  },
  { inject: ['llmEngine'] as const }
)
