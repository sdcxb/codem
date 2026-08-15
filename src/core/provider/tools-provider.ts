// @ts-nocheck
/**
 * Tools Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ToolRegistry, createDefaultToolRegistry } from '../llm/tools'

export const toolsProvider: Plugin = (ctx: any) => {
  const tools = createDefaultToolRegistry()

  const dispose = ctx.provide('tools', {
    register: (def: any) => tools.register(def),
    execute: async (name: string, input: any) => tools.execute(name, input),
    list: () => tools.list(),
    get: (name: string) => tools.get(name),
  })

  return dispose
}
