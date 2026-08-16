// @ts-nocheck
/**
 * Schedule Provider 插件 — 定时提醒和调度服务。
 *
 * 功能链：
 * - 上游：LLM 调用 schedule 工具（需新增 schedule-tools.ts）
 *         用户 UI 操作设定提醒
 * - 下游：提醒触发后通过 getInboxManager() 创建新会话/注入消息
 * - 接入点：agentic-loop.ts L547-L553 → 迭代边界检查 ctx.schedule 的到期提醒
 *           automation-manager.ts → 作为底层实现（Schedule 是 AutomationManager 的简化接口）
 *           新增 schedule-tools.ts（create_reminder/list_reminders/cancel_reminder 工具）
 *
 * 当前为空壳实现，真实实现需：
 * 1. 不独立实现，作为 AutomationManager 的简化接口
 * 2. ctx.schedule.addReminder(time, message, sessionId)
 *    → 内部调用 automationManager.registerTrigger({ type: 'timer', intervalMs: time - Date.now(), message, sessionId })
 * 3. 新增 schedule LLM 工具（类似 goal-tools.ts）
 * 4. 或直接合并 schedule 到 automation 能力，删除独立的 Schedule 服务
 */
import type { Plugin } from '../cordis/src/index.ts'

export const scheduleProvider: Plugin = (ctx: any) => {
  const reminders: Array<{ id: string; time: Date; message: string; sessionId?: string; timer?: any }> = []

  const dispose = ctx.provide('schedule', {
    addReminder(time: Date, message: string, sessionId?: string): string {
      const id = crypto.randomUUID()
      const delay = time.getTime() - Date.now()
      const reminder: any = { id, time, message, sessionId }
      if (delay > 0) {
        reminder.timer = setTimeout(() => {
          console.log(`[Schedule] Reminder: ${message}`)
          // TODO: 触发后通过 getInboxManager() 创建新会话消息
          const idx = reminders.findIndex(r => r.id === id)
          if (idx >= 0) reminders.splice(idx, 1)
        }, delay)
      }
      reminders.push(reminder)
      return id
    },
    listReminders(sessionId?: string): Array<{ id: string; time: Date; message: string }> {
      return reminders
        .filter(r => !sessionId || r.sessionId === sessionId)
        .map(({ id, time, message }) => ({ id, time, message }))
    },
    removeReminder(id: string): void {
      const r = reminders.find(r => r.id === id)
      if (r?.timer) clearTimeout(r.timer)
      const idx = reminders.findIndex(r => r.id === id)
      if (idx >= 0) reminders.splice(idx, 1)
    },
  })

  return dispose
}
