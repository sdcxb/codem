// @ts-nocheck
/**
 * Session Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionProvider: Plugin = (ctx: any) => {
  const sessions = new Map<string, any>()
  let current: string | null = null

  const dispose = ctx.provide('session', {
    create(config?: any) {
      const id = crypto.randomUUID()
      const session = { id, ...config, messages: [], createdAt: Date.now() }
      sessions.set(id, session)
      return session
    },
    get(id: string) { return sessions.get(id) },
    list() { return [...sessions.values()] },
    delete(id: string) { sessions.delete(id) },
    switch(id: string) {
      if (sessions.has(id)) current = id
    },
    getCurrent() { return current ? sessions.get(current) : undefined },
  })

  return dispose
}
