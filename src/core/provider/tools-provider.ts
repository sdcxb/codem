// @ts-nocheck
/**
 * @codem/tools — Tool registry plugin with automatic prompt section registration.
 *
 * 不创建独立的 ToolRegistry，而是从 ctx.get('llmEngine') 获取
 * LLMEngine 实例的 ToolRegistry，确保所有工具注册和执行共享同一个 registry。
 *
 * When a tool with a `guidance` field is registered, this provider automatically
 * registers a corresponding prompt section (name: `tool:<id>`, order: 100–199)
 * to the systemPrompt service. This means tool usage guidance follows the tool
 * wherever it goes — no hardcoded tool list in the system prompt.
 *
 * The provider also registers a dynamic "tool list" section that collects all
 * registered tools' names + descriptions at assembly time, so the LLM always
 * sees an up-to-date catalog of available tools.
 */
import type { Plugin } from '../cordis/src/index.ts'
import { type ToolDef } from '../llm/tools'

/** Prompt section order for the dynamic tool catalog (DSH: 100–199 range). */
const TOOL_CATALOG_ORDER = 100
/** Prompt section order for individual tool guidance (DSH: 100–199 range). */
const TOOL_GUIDANCE_BASE_ORDER = 110

export const toolsProvider: Plugin = Object.assign(
  (ctx: any) => {
    /** 获取 LLMEngine 实例的 ToolRegistry */
    const getRegistry = () => {
      const engine = ctx.get('llmEngine')
      if (engine?.tools) return engine.tools
      console.warn('[toolsProvider] llmEngine not available, tool registration will fail')
      return null
    }

    // Track prompt section disposers per tool, so unregistering a tool also
    // removes its prompt section — mirroring DSH's fiber-scoped lifecycle.
    const guidanceDisposers = new Map<string, () => void>()

    /**
     * Register a tool's guidance as a prompt section on the systemPrompt service.
     * Called automatically when a tool with `guidance` is registered.
     */
    function registerToolGuidance(tool: ToolDef): void {
      // 2026-09 token 审计：defer 工具的 guidance 不注入 systemPrompt ——
      // 模型尚未加载该工具（每轮 schema 不含它），注入是纯冗余 token；
      // 加载后其 description 已足够使用。核心工具（每轮可见）保留 guidance。
      if (!tool.guidance || tool.shouldDefer) return
      const sp = ctx.get('systemPrompt')
      if (!sp) {
        // systemPrompt not yet available — try again on next effect cycle
        ctx.effect?.(() => {
          const sp2 = ctx.get('systemPrompt')
          if (sp2 && !guidanceDisposers.has(tool.id)) {
            const dispose = sp2.addSection({
              name: `tool:${tool.id}`,
              order: TOOL_GUIDANCE_BASE_ORDER,
              text: tool.guidance!,
            })
            guidanceDisposers.set(tool.id, dispose)
          }
        }, `tools: register guidance for ${tool.id}`)
        return
      }
      const dispose = sp.addSection({
        name: `tool:${tool.id}`,
        order: TOOL_GUIDANCE_BASE_ORDER,
        text: tool.guidance,
      })
      guidanceDisposers.set(tool.id, dispose)
    }

    /** Remove a tool's guidance prompt section. */
    function unregisterToolGuidance(toolId: string): void {
      const dispose = guidanceDisposers.get(toolId)
      if (dispose) {
        dispose()
        guidanceDisposers.delete(toolId)
      }
    }

    // Register the dynamic tool catalog section.
    // 2026-09 token 审计：目录与请求 tools schema / Deferred Tools hints 三重复
    // （核心工具 description 已在每轮 tools 数组；defer 工具已在 systemPrompt 的
    // "Deferred Tools" hints）。目录文本置空 —— 保留 section 占位以免破坏
    // collectToolGuidance 的过滤逻辑，但不输出任何字符。
    const sp0 = ctx.get('systemPrompt')
    const registerCatalog = (sp: any) => {
      sp.addSection({
        name: 'tools:catalog',
        order: TOOL_CATALOG_ORDER,
        text: () => '',
      })
    }
    if (sp0) {
      registerCatalog(sp0)
    } else {
      ctx.effect?.(() => {
        const sp = ctx.get('systemPrompt')
        if (sp) registerCatalog(sp)
      }, 'tools: register catalog section')
    }

    const dispose = ctx.provide('tools', {
      register: (def: any) => {
        const registry = getRegistry()
        if (!registry) {
          console.warn('[toolsProvider] Cannot register tool: llmEngine not available')
          return
        }
        registry.register(def)
        // Auto-register guidance prompt section
        registerToolGuidance(def)
      },
      remove: (id: string) => {
        const registry = getRegistry()
        if (!registry) return false
        unregisterToolGuidance(id)
        return registry.remove(id)
      },
      execute: async (name: string, input: any) => {
        const registry = getRegistry()
        if (!registry) throw new Error('Tool engine not available')
        return registry.execute(name, input)
      },
      list: () => {
        const registry = getRegistry()
        return registry?.getAll() || []
      },
      get: (name: string) => {
        const registry = getRegistry()
        return registry?.get(name)
      },
      getDefinitions: () => {
        const registry = getRegistry()
        return registry?.getDefinitions() || []
      },
      getCoreDefinitions: () => {
        const registry = getRegistry()
        return registry?.getCoreDefinitions?.() || registry?.getDefinitions() || []
      },
      getDeferredDefinitions: () => {
        const registry = getRegistry()
        return registry?.getDeferredDefinitions?.() || []
      },
      getDeferredDefinition: (name: string) => {
        const registry = getRegistry()
        return registry?.getDeferredDefinition?.(name)
      },
    })

    return () => {
      // Clean up all guidance disposers
      for (const disp of guidanceDisposers.values()) {
        try { disp() } catch (e) { console.warn('[toolsProvider] dispose error:', e) }
      }
      guidanceDisposers.clear()
      if (dispose) dispose()
    }
  },
  { inject: ['llmEngine'] as const }
)
