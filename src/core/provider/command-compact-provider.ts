// @ts-nocheck
/**
 * @codem/command-compact — 压缩命令插件 (P1-7.9)
 *
 * 提供 /compact 命令，用户可手动触发上下文压缩。
 *
 * 功能链路融入（文档 6.2 链路 C: 上下文压缩链）：
 * - 启动时：注册 /compact 命令，用户可在输入框中输入 /compact 触发
 * - 停止时：/compact 命令不可用，用户需通过自动压缩
 */
import type { Plugin } from '../cordis/src/index.ts'

class CompactCommand {
  private handlers: Set<(sessionId: string) => Promise<void>> = new Set()

  registerHandler(handler: (sessionId: string) => Promise<void>) {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  async execute(sessionId: string): Promise<void> {
    for (const handler of this.handlers) {
      try { await handler(sessionId) } catch (e) {
        console.error('[CompactCommand] Handler failed:', e)
      }
    }
  }

  isCompactCommand(input: string): boolean {
    return input.trim().toLowerCase() === '/compact'
  }
}

export const commandCompactProvider: Plugin = (ctx: any) => {
  const cmd = new CompactCommand()

  const dispose = ctx.provide('commandCompact', {
    registerHandler(handler: any) { return cmd.registerHandler(handler) },
    async execute(sessionId: string) { return cmd.execute(sessionId) },
    isCompactCommand(input: string) { return cmd.isCompactCommand(input) },
  })

  return dispose
}
