// @ts-nocheck
/**
 * Message Storage Provider 插件 — 直接暴露 MessageStorage 模块到 ctx。
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
  // 直接暴露模块 — 与 DSH 模式一致
  const dispose = ctx.provide('messageStorage', MessageStorage)

  return dispose
}
