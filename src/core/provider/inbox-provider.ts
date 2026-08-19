// @ts-nocheck
/**
 * Inbox Provider 插件 — 可独立加载/卸载/热替换。
 *
 * InboxManagerClass 不是 export 的，因此通过 getInboxManager() 获取实例，
 * 但将其注册为 Cordis 服务，使消费者通过 ctx.get('inbox') 访问。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getInboxManager } from '../inbox/inbox'

export const inboxProvider: Plugin = (ctx: any) => {
  const manager = getInboxManager()

  const dispose = ctx.provide('inbox', {
    _active: true,
    add(item: any) { return manager.add(item) },
    list(filter?: any) { return manager.list(filter) },
    get(id: string) { return manager.get(id) },
    markRead(id: string) { return manager.markRead(id) },
    markUnread(id: string) { return manager.markUnread(id) },
    delete(id: string) { return manager.delete(id) },
  })

  // Composite dispose — stop underlying manager to eliminate double-track
  const compositeDispose = () => {
    if (manager.dispose) manager.dispose()
    dispose()
  }
  return compositeDispose
}
