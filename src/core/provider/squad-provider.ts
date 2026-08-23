// @ts-nocheck
/**
 * Squad Provider 插件 — 包装真实 Squad 管理器并接入 ctx。
 *
 * 真实实现源：
 * - src/core/squad/squad.ts（200+ 行完整实现：SquadManager + Leader-Member 编排 + worktree）
 * - src/core/squad/squad-storage.ts（SQLite 持久化）
 * - src/core/squad/squad-tools.ts（squad_* LLM 工具）
 *
 * 接入点：
 * - LLM 工具 squad_* 系列通过 ctx.squad 管理小队
 * - AgenticLoop 可通过 ctx.squad 启动子智能体并行工作
 * - UI 小队管理面板通过 ctx.squad.list() 展示小队列表
 *
 * 可作为 squadProvider（服务名 'squad'）或 squadManagerProvider（服务名 'squadManager'）加载。
 * 两者共享同一个 SquadManager 单例，但注册不同的服务名，避免冲突。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSquadManager } from '../squad/squad.ts'

/** 创建 Squad Provider 插件，可指定服务名（默认 'squad'） */
export function createSquadProvider(serviceName: string = 'squad'): Plugin {
  return (ctx: any) => {
    const manager = getSquadManager()

    const dispose = ctx.provide(serviceName, {
      _active: true,
      async create(name: string, config?: any): Promise<string> {
        return manager.createSquad(name, config)
      },
      async disband(squadId: string): Promise<void> {
        return manager.disbandSquad(squadId)
      },
      async list(): Promise<any[]> {
        return manager.listSquads()
      },
      async get(squadId: string): Promise<any> {
        return manager.getSquad(squadId)
      },
      async assignTask(squadId: string, memberId: string, task: string): Promise<void> {
        return manager.assignTask(squadId, memberId, task)
      },
      async getResults(squadId: string): Promise<any[]> {
        return manager.getSquadResults(squadId)
      },
      async addMember(squadId: string, memberConfig: any): Promise<string> {
        return manager.addMember(squadId, memberConfig)
      },
      async removeMember(squadId: string, memberId: string): Promise<void> {
        return manager.removeMember(squadId, memberId)
      },
    })

    // Composite dispose — stop underlying manager to eliminate double-track
    const compositeDispose = () => {
      if (manager.dispose) manager.dispose()
      dispose()
    }
    return compositeDispose
  }
}

/** 默认 Squad Provider — 注册服务名 'squad' */
export const squadProvider: Plugin = createSquadProvider('squad')

/** Squad Manager Provider — 注册服务名 'squadManager'（别名，同一单例） */
export const squadManagerProvider: Plugin = createSquadProvider('squadManager')
