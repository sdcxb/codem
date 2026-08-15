// @ts-nocheck
/**
 * @codem/skill — 技能能力族 Service Definition
 *
 * 定义技能管理接口契约。Provider 包实现此接口。
 * 包装现有 skill/ 下的 SkillRegistry。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface Skill {
  /** 加载已安装的技能 */
  loadInstalled(): Promise<void>
  /** 搜索技能 */
  search(query: string): Promise<SkillSearchResult[]>
  /** 获取技能定义 */
  get(skillId: string): SkillDefinition | undefined
  /** 安装技能（从 zip） */
  install(zipPath: string, onProgress?: (p: number) => void): Promise<{ success: boolean; skillId?: string; error?: string }>
  /** 卸载技能 */
  uninstall(skillId: string): Promise<void>
  /** 列出市场技能 */
  listMarket(): Promise<any[]>
  /** 从市场安装技能 */
  installFromMarket(skillId: string): Promise<{ success: boolean; error?: string }>
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  version?: string
  tools?: any[]
  mcpServers?: any[]
}

export interface SkillSearchResult {
  id: string
  name: string
  description: string
  source?: string
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** 技能服务（可替换 Provider） */
    skills: Skill
  }
}
