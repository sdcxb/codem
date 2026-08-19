// @ts-nocheck
/**
 * Schedule Provider 插件 — 定时提醒和调度服务。
 *
 * F6: 深化 — 接入 inbox/inbox.ts 在提醒触发时创建通知。
 * 支持 setInterval 和 setTimeout 两种模式。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const scheduleProvider: Plugin = (ctx: any) => {
  const reminders: Array<{ id: string; time: Date; message: string; sessionId?: string; timer?: any; recurring?: boolean; intervalMs?: number }> = []

  /** Trigger a reminder — creates inbox notification if available */
  const triggerReminder = (reminder: any) => {
    console.log(`[Schedule] Reminder triggered: ${reminder.message}`)

    // Try to create an inbox notification
    try {
      const inbox = ctx?.get?.('inbox')
      if (inbox?.add) {
        inbox.add({
          type: 'reminder',
          title: '⏰ Reminder',
          body: reminder.message,
          sessionId: reminder.sessionId,
          timestamp: Date.now(),
        })
      }
    } catch (e) { console.warn('[schedule-provider.ts]', e) }

    // Remove non-recurring reminders
    if (!reminder.recurring) {
      const idx = reminders.findIndex(r => r.id === reminder.id)
      if (idx >= 0) reminders.splice(idx, 1)
    }
  }

  const dispose = ctx.provide('schedule', {
    _active: true,

    /** Add a one-time reminder */
    addReminder(time: Date, message: string, sessionId?: string): string {
      const id = crypto.randomUUID()
      const delay = time.getTime() - Date.now()
      const reminder: any = { id, time, message, sessionId, recurring: false }

      if (delay > 0) {
        reminder.timer = setTimeout(() => triggerReminder(reminder), delay)
      } else {
        // Time already passed — trigger immediately
        triggerReminder(reminder)
        return id
      }
      reminders.push(reminder)
      return id
    },

    /** Add a recurring reminder (e.g., every 5 minutes) */
    addRecurring(intervalMs: number, message: string, sessionId?: string): string {
      const id = crypto.randomUUID()
      const reminder: any = {
        id,
        time: new Date(Date.now() + intervalMs),
        message,
        sessionId,
        recurring: true,
        intervalMs,
      }

      reminder.timer = setInterval(() => triggerReminder(reminder), intervalMs)
      reminders.push(reminder)
      return id
    },

    /** List all reminders */
    listReminders(sessionId?: string): Array<{ id: string; time: Date; message: string; recurring?: boolean }> {
      return reminders
        .filter(r => !sessionId || r.sessionId === sessionId)
        .map(({ id, time, message, recurring }) => ({ id, time, message, recurring }))
    },

    /** Remove a reminder */
    removeReminder(id: string): void {
      const idx = reminders.findIndex(r => r.id === id)
      if (idx >= 0) {
        const r = reminders[idx]
        if (r.timer) {
          if (r.recurring) clearInterval(r.timer)
          else clearTimeout(r.timer)
        }
        reminders.splice(idx, 1)
      }
    },

    /** Get next reminder time */
    getNextReminder(sessionId?: string): Date | null {
      const filtered = reminders
        .filter(r => !sessionId || r.sessionId === sessionId)
        .filter(r => r.time.getTime() > Date.now())
        .sort((a, b) => a.time.getTime() - b.time.getTime())
      return filtered.length > 0 ? filtered[0].time : null
    },
  })

  // Composite dispose — clear all timers
  const compositeDispose = () => {
    for (const r of reminders) {
      if (r.timer) {
        if (r.recurring) clearInterval(r.timer)
        else clearTimeout(r.timer)
      }
    }
    reminders.length = 0
    dispose()
  }
  return compositeDispose
}
