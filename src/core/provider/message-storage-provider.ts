// @ts-nocheck
/**
 * Message Storage Provider 插件 — 包装真实消息存储并接入 ctx。
 *
 * 真实实现源：src/core/storage/message.ts（SQLite 持久化）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('messageStorage') 读写消息
 * - 替代直接 import * as MessageStorage
 */
import type { Plugin } from '../cordis/src/index.ts'
import * as MessageStorage from '../storage/message.ts'

export const messageStorageProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('messageStorage', {
    createMessage(msg: any, sessionId: string) {
      return MessageStorage.createMessage(msg, sessionId)
    },
    listMessages(sessionId: string) {
      return MessageStorage.listMessages(sessionId)
    },
    updateMessage(msgId: string, updates: any) {
      return MessageStorage.updateMessage(msgId, updates)
    },
    deleteMessage(msgId: string) {
      return MessageStorage.deleteMessage(msgId)
    },
    addToolCall(msgId: string, toolCall: any) {
      return MessageStorage.addToolCall(msgId, toolCall)
    },
    updateToolCall(msgId: string, toolCallId: string, updates: any) {
      return MessageStorage.updateToolCall(msgId, toolCallId, updates)
    },
  })

  return dispose
}
