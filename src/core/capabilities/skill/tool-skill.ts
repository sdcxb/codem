// @ts-nocheck
/**
 * @codem/tool-skill — 技能工具 Consumer
 *
 * 通过 ctx.skills 消费技能能力，注册 skill_search/skill_install/skill_uninstall 工具。
 */
import { defineTool, useCtx } from '../../consumer/index.ts'

export const inject = ['skills', 'tools'] as const

export function apply() {
  const ctx = useCtx()

  defineTool({
    name: 'skill_search',
    description: 'Search for available skills',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
    async execute({ query }: { query: string }) {
      if (!ctx.skills) return 'Skills not available'
      const results = await ctx.skills.search(query)
      return results.map(r => `[${r.name}] ${r.description} (${r.id})`).join('\n')
    },
  })

  defineTool({
    name: 'skill_install',
    description: 'Install a skill from the market',
    inputSchema: {
      type: 'object',
      properties: { skillId: { type: 'string', description: 'Skill ID to install' } },
      required: ['skillId'],
    },
    requirePermission: true,
    async execute({ skillId }: { skillId: string }) {
      if (!ctx.skills) return 'Skills not available'
      const result = await ctx.skills.installFromMarket(skillId)
      return result.success ? `Skill ${skillId} installed successfully` : `Failed: ${result.error}`
    },
  })
}
