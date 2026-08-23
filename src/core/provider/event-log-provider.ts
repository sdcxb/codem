// @ts-nocheck
/**
 * Event Log Provider 插件 — 直接暴露 EventLog 实例到 ctx。
 *
 * 真实实现源：src/core/storage/event-log.ts（EventLog 类 + getEventLog()）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('eventLog') 记录事件
 * - ToolPipeline 通过 ctx.get('eventLog') 记录工具执行事件
 * - 替代直接 import { getEventLog }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getEventLog } from '../storage/event-log.ts'

export const eventLogProvider: Plugin = (ctx: any) => {
  const eventLog = getEventLog()

  // 直接暴露实例 — 与 DSH 模式一致
  const dispose = ctx.provide('eventLog', eventLog)

  return dispose
}
