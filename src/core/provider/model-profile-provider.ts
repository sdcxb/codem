// @ts-nocheck
/**
 * Model Profile Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 ModelProfileManager 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getModelProfileManager()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ModelProfileManager } from '../llm/model-profile'

export const modelProfileProvider: Plugin = (ctx: any) => {
  const manager = new ModelProfileManager()

  const dispose = ctx.provide('modelProfile', {
    reload() { return manager.reload() },
    getAll() { return manager.getAll() },
    getActiveProfile() { return manager.getActiveProfile() },
    getActiveProfileId() { return manager.getActiveProfileId() },
    setActiveProfile(id: string) { return manager.setActiveProfile(id) },
    resolveSlot(slot: string) { return manager.resolveSlot(slot) },
    getFallbackChain(slot: string) { return manager.getFallbackChain(slot) },
    createProfile(profile: any) { return manager.createProfile(profile) },
    updateProfile(id: string, updates: any) { return manager.updateProfile(id, updates) },
    deleteProfile(id: string) { return manager.deleteProfile(id) },
  })

  return dispose
}
