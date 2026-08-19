// @ts-nocheck
/**
 * Tool Render Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 ToolRenderRegistry 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getToolRenderRegistry()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ToolRenderRegistry } from '../llm/tool-renderer'

export const toolRenderProvider: Plugin = (ctx: any) => {
  const registry = new ToolRenderRegistry()

  const dispose = ctx.provide('toolRender', {
    register(toolName: string, renderer: any) { registry.register(toolName, renderer) },
    get(toolName: string) { return registry.get(toolName) },
    getDefault() { return registry.getDefault() },
    setDefault(renderer: any) { registry.setDefault(renderer) },
    render(toolName: string, result: any, context?: any) {
      const renderer = registry.get(toolName)
      return renderer.render(result, context)
    },
  })

  return dispose
}
