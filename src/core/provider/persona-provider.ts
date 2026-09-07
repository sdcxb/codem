// @ts-nocheck
/**
 * @codem/persona — 人设卡插件（B2，对标 EAC dsh-soul-md）
 *
 * 服务面（ctx.persona）：持久化人设卡 CRUD + 激活切换 + 提示词段生成。
 * 主 prompt 注入：llm/index.ts buildSystemPromptAsync 经
 * buildPersonaPromptSection() 消费激活人设（文件模式支持热重载）——
 * 修复历史缺陷（旧 provider 仅内存 Map 且从未接入主 prompt 的孤儿代码）。
 *
 * 该插件非 core：用户可在插件管理禁用（禁用后 buildPersonaPromptSection
 * 返回空串，主 prompt 不注入人设段）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  listPersonaCards, savePersonaCard, deletePersonaCard,
  getPersonaCard, getActivePersonaId, setActivePersona, clearActivePersona,
  getActivePersonaPrompt, buildPersonaPromptSection,
  type PersonaCard,
} from '../persona/persona'

export const personaProvider: Plugin = (ctx: any) => {
  const s = {
    list(): PersonaCard[] { return listPersonaCards() },
    get(id: string): PersonaCard | null { return getPersonaCard(id) },
    save(input: { id?: string; name: string; content?: string; path?: string; fallback?: string; order?: number }): PersonaCard {
      return savePersonaCard(input)
    },
    remove(id: string): void { deletePersonaCard(id) },
    active(): string { return getActivePersonaId() },
    activate(id: string): void { setActivePersona(id) },
    deactivate(): void { clearActivePersona() },
    async prompt(): Promise<string | null> { return getActivePersonaPrompt() },
    async section(): Promise<string> { return buildPersonaPromptSection() },
    /** 兼容旧调用方（如曾消费 buildPrompt 的地方）：返回激活人设内容或默认助手人格 */
    async buildPrompt(): Promise<string> { return (await getActivePersonaPrompt()) || 'You are a helpful assistant.' },
  }
  return ctx.provide('persona', s)
}
