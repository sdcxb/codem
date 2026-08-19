// @ts-nocheck
/**
 * @codem/repeat-tool-reminder — 重复工具提醒插件 (P2-7.12)
 *
 * 检测 LLM 是否重复调用相同工具执行相同操作，发出提醒。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链 → 工具调用后检查）：
 * - 启动时：注册重复检测器，每次工具调用后检查
 * - 停止时：不检测重复调用，LLM 可能陷入循环
 */
import type { Plugin } from '../cordis/src/index.ts'

class RepeatToolReminder {
  private history: Map<string, { toolName: string; input: string; timestamp: number }[]> = new Map()
  private threshold: number = 3 // 连续相同调用超过 3 次时提醒
  private windowMs: number = 60000 // 60 秒窗口内

  record(sessionId: string, toolName: string, input: string) {
    if (!this.history.has(sessionId)) {
      this.history.set(sessionId, [])
    }
    const list = this.history.get(sessionId)!
    list.push({ toolName, input, timestamp: Date.now() })
    // 清理旧记录
    const cutoff = Date.now() - this.windowMs
    while (list.length > 0 && list[0].timestamp < cutoff) {
      list.shift()
    }
  }

  check(sessionId: string): { isRepeat: boolean; message?: string } {
    const list = this.history.get(sessionId)
    if (!list || list.length === 0) return { isRepeat: false }

    // 检查最近的连续相同调用
    const last = list[list.length - 1]
    let consecutiveCount = 0
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].toolName === last.toolName && list[i].input === last.input) {
        consecutiveCount++
      } else {
        break
      }
    }

    if (consecutiveCount >= this.threshold) {
      return {
        isRepeat: true,
        message: `⚠️ 检测到工具 "${last.toolName}" 已连续调用 ${consecutiveCount} 次相同操作，请检查是否有错误。`,
      }
    }

    return { isRepeat: false }
  }

  clear(sessionId?: string) {
    if (sessionId) {
      this.history.delete(sessionId)
    } else {
      this.history.clear()
    }
  }
}

export const repeatToolReminderProvider: Plugin = (ctx: any) => {
  const reminder = new RepeatToolReminder()

  const dispose = ctx.provide('repeatToolReminder', {
    record(sessionId: string, toolName: string, input: string) { reminder.record(sessionId, toolName, input) },
    check(sessionId: string) { return reminder.check(sessionId) },
    clear(sessionId?: string) { reminder.clear(sessionId) },
  })

  return dispose
}
