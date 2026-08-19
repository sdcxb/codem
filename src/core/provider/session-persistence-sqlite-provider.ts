// @ts-nocheck
/**
 * @codem/session-persistence-sqlite — SQLite 会话持久化插件
 *
 * 将会话数据持久化到 SQLite，替代直接 import SessionStorage。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 E: 会话恢复链 + 链路 A: LLM 调用链）：
 * - 启动时：注册会话持久化服务，buildMessages() 可读取历史消息
 * - 停止时：消息不持久化，刷新后丢失 → 文档 6.4 核心链路: ❌ 消息丢失
 */
import type { Plugin } from '../cordis/src/index.ts'
import * as SessionStorage from '../storage/session'
import * as MessageStorage from '../storage/message'

export const sessionPersistenceSqliteProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('sessionPersistence', {
    // Session CRUD
    createSession(session: any) { return SessionStorage.createSession(session) },
    listSessions(projectId: string) { return SessionStorage.listSessions(projectId) },
    getSession(sessionId: string) { return SessionStorage.getSession(sessionId) },
    updateSession(sessionId: string, updates: any) { return SessionStorage.updateSession(sessionId, updates) },
    deleteSession(sessionId: string) { return SessionStorage.deleteSession(sessionId) },

    // Message CRUD
    createMessage(msg: any, sessionId: string) { return MessageStorage.createMessage(msg, sessionId) },
    listMessages(sessionId: string) { return MessageStorage.listMessages(sessionId) },
    deleteMessagesByIds(ids: string[]) { return MessageStorage.deleteMessagesByIds(ids) },
    messagesToLLMMessages(messages: any[]) { return MessageStorage.messagesToLLMMessages(messages) },
  })

  return dispose
}
