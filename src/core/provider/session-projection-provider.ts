// @ts-nocheck
/**
 * @codem/session-projection — 会话投影插件 (CQRS 读模型)
 *
 * 提供会话的读模型投影，支持快速查询不直接访问存储层。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入：
 * - 启动时：注册投影服务，UI 可通过投影快速获取会话列表
 * - 停止时：回退到直接查询 SQLite → 性能略降但功能不中断
 */
import type { Plugin } from '../cordis/src/index.ts'

class SessionProjection {
  private projections: Map<string, any> = new Map()

  project(sessionId: string, data: any) {
    this.projections.set(sessionId, { ...data, projectedAt: Date.now() })
  }

  get(sessionId: string) {
    return this.projections.get(sessionId)
  }

  list(filter?: any) {
    let items = Array.from(this.projections.values())
    if (filter?.projectId) {
      items = items.filter(s => s.projectId === filter.projectId)
    }
    return items
  }

  invalidate(sessionId: string) {
    this.projections.delete(sessionId)
  }

  clear() {
    this.projections.clear()
  }
}

export const sessionProjectionProvider: Plugin = (ctx: any) => {
  const projection = new SessionProjection()

  const dispose = ctx.provide('sessionProjection', {
    project(sessionId: string, data: any) { projection.project(sessionId, data) },
    get(sessionId: string) { return projection.get(sessionId) },
    list(filter?: any) { return projection.list(filter) },
    invalidate(sessionId: string) { projection.invalidate(sessionId) },
    clear() { projection.clear() },
  })

  return dispose
}
