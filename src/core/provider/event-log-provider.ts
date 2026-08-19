// @ts-nocheck
/**
 * Event Log Provider 插件 — 包装真实事件日志并接入 ctx。
 *
 * 真实实现源：src/core/storage/event-log.ts（EventLog 类 + getEventLog()）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('eventLog') 记录事件
 * - ToolPipeline 通过 ctx.get('eventLog') 记录工具执行事件
 * - 替代直接 import { getEventLog }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { EventLog, getEventLog } from '../storage/event-log.ts'

export const eventLogProvider: Plugin = (ctx: any) => {
  const log = getEventLog()

  const dispose = ctx.provide('eventLog', {
    _active: true,
    log(event: string, data?: any): void {
      return log.log(event, data)
    },
    getEvents(filter?: any): any[] {
      return log.getEvents(filter)
    },
    clear(): void {
      return log.clear()
    },
  })

  // Composite dispose — stop underlying log to eliminate double-track
  const compositeDispose = () => {
    if (log.dispose) log.dispose()
    dispose()
  }
  return compositeDispose
}
