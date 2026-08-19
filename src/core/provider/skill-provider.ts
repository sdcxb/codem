// @ts-nocheck
/**
 * Skill Provider 插件 — 可独立加载/卸载/热替换。
 *
 * A3 改造：从"假 DI 代理全局单例"升级为"真 DI 暴露完整 Provider 能力"。
 * 保留 getSkillRegistry() 向后兼容，同时暴露 registerProvider/snapshot 等新 API。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { SkillRegistry } from '../skill/skill'

export const skillProvider: Plugin = (ctx: any) => {
  // 在 Provider 内部创建实例，生命周期与 fiber 绑定
  const skillRegistry = new SkillRegistry()

  // 暴露完整的 SkillRegistry 能力到 ctx.skills
  const skillService = {
    // ===== 旧 API（向后兼容） =====
    register: (def: any) => skillRegistry.register(def),
    execute: async (name: string, input: any) => skillRegistry.execute(name, input),
    list: () => skillRegistry.list(),
    install: async (name: string) => { await skillRegistry.install(name) },
    uninstall: (name: string) => { skillRegistry.uninstall(name) },

    // ===== A2 新 API（DSH-aligned） =====
    /** 注册可插拔的 skill 发现 Provider */
    registerProvider: (create: any) => skillRegistry.registerProvider(create),
    /** 获取 skill catalog 快照 */
    snapshot: async (options?: any) => skillRegistry.snapshot(options),
    /** 异步列出所有 skill 摘要 */
    listSummaries: async (options?: any) => skillRegistry.listSummaries(options),
    /** 异步加载完整 skill 定义 */
    getSkill: async (name: string, options?: any) => skillRegistry.getSkill(name, options),
    /** 注册变更监听 */
    onSkillsChange: (callback: () => void) => skillRegistry.onSkillsChange(callback),
    /** 获取 catalog revision */
    getCatalogRevision: () => skillRegistry.getCatalogRevision(),
    /** 获取底层 registry（用于直接访问） */
    getRegistry: () => skillRegistry,
  }

  const dispose = ctx.provide('skill', skillService)

  return dispose
}
