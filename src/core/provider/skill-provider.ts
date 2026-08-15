// @ts-nocheck
/**
 * Skill Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSkillRegistry } from '../skill/skill'

export const skillProvider: Plugin = (ctx: any) => {
  const skillRegistry = getSkillRegistry()

  const dispose = ctx.provide('skill', {
    register: (def: any) => skillRegistry.register(def),
    execute: async (name: string, input: any) => skillRegistry.execute(name, input),
    list: () => skillRegistry.list(),
    install: async (name: string) => { await skillRegistry.install(name) },
    uninstall: (name: string) => { skillRegistry.uninstall(name) },
  })

  return dispose
}
