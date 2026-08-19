// @ts-nocheck
/**
 * @codem/session-query-sqlite — SQLite 会话查询引擎，复杂条件检索和分页
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sessionQuerySqliteProvider: Plugin = (ctx: any) => {
  const s = {
    async query(o) { const sess=ctx.get('session'); return sess&&sess.queryMessages?sess.queryMessages(o):[] },
    async search(t, o={}) { const sess=ctx.get('session'); return sess&&sess.searchMessages?sess.searchMessages(t,o.limit||20):[] },
    async count(id) { const sess=ctx.get('session'); return sess&&sess.countMessages?sess.countMessages(id):0 },
  }
  return ctx.provide('sessionQuerySqlite', s)
}
