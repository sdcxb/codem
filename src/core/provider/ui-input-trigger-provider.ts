// @ts-nocheck
/**
 * @codem/ui-input-trigger — 输入触发器插件 (P2-7.14)
 *
 * 管理输入框的触发器（如 / 命令补全、@ 提及等）。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链 → app.input）：
 * - 启动时：注册触发器服务，输入框通过它获取可用触发器
 * - 停止时：触发器不可用，输入框仅支持纯文本
 */
import type { Plugin } from '../cordis/src/index.ts'

interface Trigger {
  id: string
  pattern: string // 如 '/' 或 '@'
  handler: (input: string, position: number) => { suggestions: { label: string; insertText: string }[] }
}

class InputTriggerManager {
  private triggers: Map<string, Trigger> = new Map()

  register(trigger: Trigger) {
    this.triggers.set(trigger.id, trigger)
  }

  unregister(id: string) {
    this.triggers.delete(id)
  }

  match(input: string, position: number): Trigger | null {
    const beforeCursor = input.substring(0, position)
    for (const trigger of this.triggers.values()) {
      if (beforeCursor.endsWith(trigger.pattern) || beforeCursor.match(new RegExp(`${trigger.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*$`))) {
        return trigger
      }
    }
    return null
  }

  getSuggestions(input: string, position: number): { label: string; insertText: string }[] {
    const trigger = this.match(input, position)
    if (!trigger) return []
    return trigger.handler(input, position).suggestions
  }

  list(): Trigger[] {
    return Array.from(this.triggers.values())
  }
}

export const uiInputTriggerProvider: Plugin = (ctx: any) => {
  const manager = new InputTriggerManager()

  const dispose = ctx.provide('uiInputTrigger', {
    register(trigger: any) { manager.register(trigger) },
    unregister(id: string) { manager.unregister(id) },
    match(input: string, position: number) { return manager.match(input, position) },
    getSuggestions(input: string, position: number) { return manager.getSuggestions(input, position) },
    list() { return manager.list() },
  })

  return dispose
}
