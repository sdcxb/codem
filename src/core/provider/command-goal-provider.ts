// @ts-nocheck
/**
 * @codem/command-goal — 目标命令插件 (P1-7.10)
 *
 * 提供 /goal 命令，用户可设置和管理工作目标。
 *
 * 功能链路融入：
 * - 启动时：注册 /goal 命令
 * - 停止时：/goal 命令不可用，用户无法通过命令设置目标
 */
import type { Plugin } from '../cordis/src/index.ts'

class GoalCommand {
  private handlers: Set<(action: string, args: string) => Promise<void>> = new Set()

  registerHandler(handler: (action: string, args: string) => Promise<void>) {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  async execute(action: string, args: string): Promise<void> {
    for (const handler of this.handlers) {
      try { await handler(action, args) } catch (e) {
        console.error('[GoalCommand] Handler failed:', e)
      }
    }
  }

  isGoalCommand(input: string): boolean {
    return input.trim().toLowerCase().startsWith('/goal')
  }

  parseGoalCommand(input: string): { action: string; args: string } | null {
    const trimmed = input.trim()
    if (!trimmed.toLowerCase().startsWith('/goal')) return null
    const parts = trimmed.substring(5).trim().split(/\s+(.*)/)
    return { action: parts[0] || 'set', args: parts[1] || '' }
  }
}

export const commandGoalProvider: Plugin = (ctx: any) => {
  const cmd = new GoalCommand()

  const dispose = ctx.provide('commandGoal', {
    registerHandler(handler: any) { return cmd.registerHandler(handler) },
    async execute(action: string, args: string) { return cmd.execute(action, args) },
    isGoalCommand(input: string) { return cmd.isGoalCommand(input) },
    parseGoalCommand(input: string) { return cmd.parseGoalCommand(input) },
  })

  return dispose
}
