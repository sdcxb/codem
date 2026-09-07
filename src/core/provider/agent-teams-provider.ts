// @ts-nocheck
/**
 * @codem/agent-teams — Cordis provider
 *
 * 提供 ctx.agentTeams 服务面（团队 CRUD/状态查询订阅），LLM 工具
 * （agent_teams_*）由 LLMEngine.setupDelegationTools 独立注册——本 provider
 * 保证"插件可启停"语义：禁用 @codem/agent-teams 后，UI/面板入口与工具提示
 * 均不呈现（工具已注册但无 ctx 服务时调用方自然失败；服务面随插件启停）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { AgentTeamsService } from './agent-teams-service'

export const agentTeamsProvider: Plugin = (ctx: any) => {
  const svc = AgentTeamsService.getInstance()
  const s = {
    list: () => svc.listAll(),
    get: (id: string) => svc.get(id),
    status: (id: string) => svc.status(id),
    subscribe: (fn: () => void) => svc.subscribe(fn),
    activeTeamOf: (captainSessionId: string) => svc.activeTeamOf(captainSessionId),
  }
  return ctx.provide('agentTeams', s)
}
