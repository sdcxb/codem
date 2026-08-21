// @ts-nocheck
/**
 * @codem/tools — Tool registry plugin with automatic prompt section registration.
 *
 * Follows the DSH pattern (packages/core/tools/src/index.ts:832):
 *   ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
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
import { ToolRegistry, createDefaultToolRegistry, type ToolDef } from '../llm/tools'

/** Prompt section order for the dynamic tool catalog (DSH: 100–199 range). */
const TOOL_CATALOG_ORDER = 100
/** Prompt section order for individual tool guidance (DSH: 100–199 range). */
const TOOL_GUIDANCE_BASE_ORDER = 110

export const toolsProvider: Plugin = (ctx: any) => {
  const tools = createDefaultToolRegistry(ctx)

  // Track prompt section disposers per tool, so unregistering a tool also
  // removes its prompt section — mirroring DSH's fiber-scoped lifecycle.
  const guidanceDisposers = new Map<string, () => void>()

  /**
   * Register a tool's guidance as a prompt section on the systemPrompt service.
   * Called automatically when a tool with `guidance` is registered.
   */
  function registerToolGuidance(tool: ToolDef): void {
    if (!tool.guidance) return
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

  // Wrap the registry's register method to auto-register guidance sections.
  const originalRegister = tools.register.bind(tools)
  tools.register = (tool: ToolDef) => {
    originalRegister(tool)
    registerToolGuidance(tool)
  }
  // Wrap remove to also remove guidance.
  const originalRemove = tools.remove.bind(tools)
  tools.remove = (id: string) => {
    unregisterToolGuidance(id)
    return originalRemove(id)
  }

  // Register the dynamic tool catalog section.
  // This section collects all registered tools' id + description at assembly
  // time, so the LLM always sees the current tool set without hardcoding.
  const sp0 = ctx.get('systemPrompt')
  const registerCatalog = (sp: any) => {
    sp.addSection({
      name: 'tools:catalog',
      order: TOOL_CATALOG_ORDER,
      text: () => {
        const all = tools.getAll()
        if (all.length === 0) return ''
        const lines = all.map((t: ToolDef) => `- **${t.id}**: ${t.description.split('\n')[0]}`)
        return `## Available Tools\n\n${lines.join('\n')}`
      },
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
    register: (def: any) => tools.register(def),
    remove: (id: string) => tools.remove(id),
    execute: async (name: string, input: any) => tools.execute(name, input),
    list: () => tools.getAll(),
    get: (name: string) => tools.get(name),
    getDefinitions: () => tools.getDefinitions(),
    getCoreDefinitions: () => tools.getCoreDefinitions(),
    getDeferredDefinitions: () => tools.getDeferredDefinitions(),
    getDeferredDefinition: (name: string) => tools.getDeferredDefinition(name),
  })

  return dispose
}
