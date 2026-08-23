// @ts-nocheck
/**
 * @codem/ui-deliverables — 交付物管理 UI 插件
 *
 * 对标 DSH packages/client/ui-deliverables/src/client/index.ts。
 * 注册 DeliverableFiles 组件到 Slot（turn-tail 模式），同时提供交付物服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { DeliverableFiles } from '../../components/DeliverableFiles'

interface Deliverable {
  id: string
  sessionId: string
  type: 'file_create' | 'file_edit' | 'file_delete' | 'command_output'
  path?: string
  content?: string
  diff?: string
  status: 'pending' | 'accepted' | 'rejected'
  timestamp: number
}

class DeliverablesService {
  private deliverables: Map<string, Deliverable> = new Map()
  private listeners: Array<(deliverable: Deliverable) => void> = []

  register(sessionId: string, data: Omit<Deliverable, 'id' | 'sessionId' | 'status' | 'timestamp'>): string {
    const id = crypto.randomUUID()
    const deliverable: Deliverable = { ...data, id, sessionId, status: 'pending', timestamp: Date.now() }
    this.deliverables.set(id, deliverable)
    this.notify(deliverable)
    return id
  }
  get(id: string): Deliverable | undefined { return this.deliverables.get(id) }
  getBySession(sessionId: string): Deliverable[] { return [...this.deliverables.values()].filter(d => d.sessionId === sessionId) }
  accept(id: string) { const d = this.deliverables.get(id); if (d) { d.status = 'accepted'; this.notify(d) } }
  reject(id: string) { const d = this.deliverables.get(id); if (d) { d.status = 'rejected'; this.notify(d) } }
  acceptAll(sessionId: string) { for (const d of this.deliverables.values()) { if (d.sessionId === sessionId && d.status === 'pending') { d.status = 'accepted'; this.notify(d) } } }
  getPending(sessionId?: string): Deliverable[] { return [...this.deliverables.values()].filter(d => d.status === 'pending' && (!sessionId || d.sessionId === sessionId)) }
  clearSession(sessionId: string) { for (const [id, d] of this.deliverables) { if (d.sessionId === sessionId) this.deliverables.delete(id) } }
  subscribe(listener: (deliverable: Deliverable) => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter(l => l !== listener) } }
  private notify(deliverable: Deliverable) { this.listeners.forEach(l => { try { l(deliverable) } catch (e) { console.warn('[ui-deliverables-provider.ts]', e) } }) }
}

export const uiDeliverablesProvider: Plugin = Object.assign(
  (ctx: any) => {
    const service = new DeliverablesService()

    const dispose = ctx.provide('uiDeliverables', {
      register: (sessionId: string, data: any) => service.register(sessionId, data),
      get: (id: string) => service.get(id),
      getBySession: (sessionId: string) => service.getBySession(sessionId),
      accept: (id: string) => service.accept(id),
      reject: (id: string) => service.reject(id),
      acceptAll: (sessionId: string) => service.acceptAll(sessionId),
      getPending: (sessionId?: string) => service.getPending(sessionId),
      clearSession: (sessionId: string) => service.clearSession(sessionId),
      subscribe: (listener: any) => service.subscribe(listener),
    })

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.deliverable-files', id: 'r8-deliverablefiles', priority: 5 }, DeliverableFiles)

    // 使用 slots.inject 声明消费依赖：conversation.session 存在时注册
    const injectUnreg = slots.inject('conversation.session', () =>
      slots.register({ name: 'conversation.session', id: 'r8-deliverablefiles-sub', priority: 3 }, DeliverableFiles)
    )

    return () => {
      if (dispose) dispose()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
