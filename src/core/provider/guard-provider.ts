// @ts-nocheck
/**
 * Guard Provider 插件 — 工具调用去重和截止时间检查。
 *
 * 功能链：
 * - 上游：ToolPipeline 的 guard 层（tool-pipeline.ts Layer 2）
 * - 下游：工具执行前拦截重复调用 / AgenticLoop 迭代时检查截止时间
 * - 接入点：tool-pipeline.ts L609-L610（注册为 GuardMiddleware）
 *           agentic-loop.ts L542（while 循环条件增加 guard.checkDeadline()）
 *
 * 当前为空壳实现，真实实现需：
 * 1. checkRepeat() 取代 AgenticLoop 中手工 readCache/writeCache 去重（L207-L225）
 * 2. checkDeadline() 接入 AgenticLoop 的 maxIterations 检查
 * 3. 第三方插件可注册自定义 GuardMiddleware（如"禁止在测试目录写文件"）
 */
import type { Plugin } from '../cordis/src/index.ts'

export const guardProvider: Plugin = (ctx: any) => {
  const callHistory = new Map<string, any[]>()

  const dispose = ctx.provide('guard', {
    checkRepeat(toolName: string, args: any): { isRepeat: boolean; message?: string } {
      const argStr = JSON.stringify(args)
      const now = Date.now()
      const history = callHistory.get('global') || []
      const recent = history.filter((h: any) => h.tool === toolName && h.args === argStr && now - h.time < 5000)
      if (recent.length > 0) {
        return { isRepeat: true, message: `Tool "${toolName}" was called with the same args recently` }
      }
      history.push({ tool: toolName, args: argStr, time: now })
      if (history.length > 100) history.shift()
      callHistory.set('global', history)
      return { isRepeat: false }
    },
    checkDeadline(_sessionId: string): { exceeded: boolean; remaining?: number } {
      // TODO: 接入 AgenticLoop 的 maxIterations 检查
      return { exceeded: false }
    },
  })

  return dispose
}
