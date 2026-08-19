// @ts-nocheck
/**
 * @codem/skill-filesystem — 文件系统技能 Provider
 *
 * P2-2/F3: 消除架构级重复 — 被 provider/skill-filesystem-provider.ts 包装后注册到 ctx。
 * @deprecated 新代码请直接从 provider/ 导入。
 *
 * 使用本地文件系统管理技能。
 * 包装现有 skill/registry.ts + skill/installer.ts 的实现。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { Skill, SkillDefinition, SkillSearchResult } from './index.ts'
import { getSkillRegistry, loadInstalledSkills, installSkillFromZip, uninstallSkill } from '../../skill/index.ts'
import { listMarketSkills, installMarketSkill } from '../../skill/skill-market-client'

export class FilesystemSkill implements Skill {
  constructor(private ctx: Context) {}

  async loadInstalled(): Promise<void> {
    await loadInstalledSkills()
  }

  async search(query: string): Promise<SkillSearchResult[]> {
    const registry = getSkillRegistry()
    const all = registry.listSkills()
    return all
      .filter(s => s.name.toLowerCase().includes(query.toLowerCase()) || s.description?.toLowerCase().includes(query.toLowerCase()))
      .map(s => ({ id: s.id, name: s.name, description: s.description || '', source: s.source }))
  }

  get(skillId: string): SkillDefinition | undefined {
    const registry = getSkillRegistry()
    const skill = registry.getSkill(skillId)
    if (!skill) return undefined
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description || '',
      version: skill.version,
      tools: skill.tools,
      mcpServers: skill.mcpServers,
    }
  }

  async install(zipPath: string, onProgress?: (p: number) => void): Promise<{ success: boolean; skillId?: string; error?: string }> {
    try {
      const result = await installSkillFromZip(zipPath, onProgress)
      return result
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async uninstall(skillId: string): Promise<void> {
    await uninstallSkill(skillId)
  }

  async listMarket(): Promise<any[]> {
    return await listMarketSkills()
  }

  async installFromMarket(skillId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await installMarketSkill(skillId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

export const inject = [] as const
export const provide = ['skills'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('skills', new FilesystemSkill(ctx))
}
