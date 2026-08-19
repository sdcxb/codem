// @ts-nocheck
/**
 * @codem/ui-skill — 技能面板插件 (P2-7.14)
 *
 * 提供技能管理 UI 面板，用户可查看、启用、禁用技能。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链 → app.sidebar → 技能面板）：
 * - 启动时：注册技能面板服务，侧边栏显示技能管理入口
 * - 停止时：技能面板不可用，用户无法通过 UI 管理技能
 */
import type { Plugin } from '../cordis/src/index.ts'

class SkillPanelManager {
  private skills: Map<string, { id: string; name: string; description: string; enabled: boolean; category: string }> = new Map()

  registerSkill(skill: { id: string; name: string; description: string; category: string }) {
    this.skills.set(skill.id, { ...skill, enabled: true })
  }

  unregisterSkill(id: string) {
    this.skills.delete(id)
  }

  enable(id: string) {
    const skill = this.skills.get(id)
    if (skill) skill.enabled = true
  }

  disable(id: string) {
    const skill = this.skills.get(id)
    if (skill) skill.enabled = false
  }

  list(category?: string) {
    const all = Array.from(this.skills.values())
    if (category) return all.filter(s => s.category === category)
    return all
  }

  listEnabled() {
    return this.list().filter(s => s.enabled)
  }

  get(id: string) {
    return this.skills.get(id) || null
  }
}

export const uiSkillPanelProvider: Plugin = (ctx: any) => {
  const manager = new SkillPanelManager()

  const dispose = ctx.provide('uiSkillPanel', {
    registerSkill(skill: any) { manager.registerSkill(skill) },
    unregisterSkill(id: string) { manager.unregisterSkill(id) },
    enable(id: string) { manager.enable(id) },
    disable(id: string) { manager.disable(id) },
    list(category?: string) { return manager.list(category) },
    listEnabled() { return manager.listEnabled() },
    get(id: string) { return manager.get(id) },
  })

  return dispose
}
