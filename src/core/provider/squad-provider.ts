// @ts-nocheck
/**
 * Squad Provider 插件 — 多 Agent 编组服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const squadProvider: Plugin = (ctx: any) => {
  const squads = new Map<string, any>()

  const dispose = ctx.provide('squad', {
    create(name: string, members: string[]) { const id = crypto.randomUUID(); squads.set(id, { id, name, members }); return id },
    get(squadId: string) { return squads.get(squadId) },
    list() { return [...squads.values()].map(s => ({ id: s.id, name: s.name, memberCount: s.members.length })) },
    addMember(squadId: string, member: string) { const s = squads.get(squadId); if (s && !s.members.includes(member)) s.members.push(member) },
    removeMember(squadId: string, member: string) { const s = squads.get(squadId); if (s) s.members = s.members.filter((m: string) => m !== member) },
    disband(squadId: string) { squads.delete(squadId) },
  })

  return dispose
}
