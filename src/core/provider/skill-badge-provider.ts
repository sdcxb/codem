// @ts-nocheck
/**
 * @codem/skill-badge — 技能徽章，技能成就和展示系统
 */
import type { Plugin } from '../cordis/src/index.ts'

export const skillBadgeProvider: Plugin = (ctx: any) => {
  const s = {
    badges: new Map(),
    add(name, badge) { this.badges.set(name, badge) },
    get(name) { return this.badges.get(name) },
    list() { return [...this.badges.values()] },
    async award(skillName, userId) { return {skillName,userId,awardedAt:Date.now(),badge:this.get(skillName)} },
  }
  return ctx.provide('skillBadge', s)
}
