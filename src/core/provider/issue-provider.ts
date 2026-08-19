// @ts-nocheck
/**
 * Issue Provider 插件 — 可独立加载/卸载/热替换。
 *
 * IssueManagerClass 不是 export 的，因此通过 getIssueManager() 获取实例，
 * 但将其注册为 Cordis 服务，使消费者通过 ctx.get('issue') 访问。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getIssueManager } from '../issue/issue'

export const issueProvider: Plugin = (ctx: any) => {
  const manager = getIssueManager()

  const dispose = ctx.provide('issue', {
    _active: true,
    create(data: any) { return manager.create(data) },
    list(filter?: any) { return manager.list(filter) },
    get(id: string) { return manager.get(id) },
    update(id: string, update: any) { return manager.update(id, update) },
    delete(id: string) { return manager.delete(id) },
  })

  // Composite dispose — stop underlying manager to eliminate double-track
  const compositeDispose = () => {
    if (manager.dispose) manager.dispose()
    dispose()
  }
  return compositeDispose
}
