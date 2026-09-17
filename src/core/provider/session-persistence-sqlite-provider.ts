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
    /*
     * 第 44 轮：把 `confirmBulk` 透传出去。
     *
     * 删会话是**级联删除的源头**（sessions → messages / tool_calls / session_events），
     * Rust 侧按**真实影响行数**判定：超过 50 行必须显式声明"我知道这是批量删除"。
     * 这个 provider 是扩展点，调用方是插件 —— 它才知道自己是在响应用户的破坏性操作
     * （该传 true）还是在做对账/清理（不该传）。
     * **缺省不传**是刻意的：安全默认必须是"不确认"，否则闸门对插件路径形同不存在。
     */
    deleteSession(sessionId: string, opts?: { confirmBulk?: boolean }) {
      return SessionStorage.deleteSession(sessionId, opts)
    },

    // Message CRUD
    createMessage(msg: any, sessionId: string) { return MessageStorage.createMessage(msg, sessionId) },
    listMessages(sessionId: string) { return MessageStorage.listMessages(sessionId) },
    deleteMessagesByIds(ids: string[]) { return MessageStorage.deleteMessagesByIds(ids) },
    messagesToLLMMessages(messages: any[]) { return MessageStorage.messagesToLLMMessages(messages) },
  })

  return dispose
}
