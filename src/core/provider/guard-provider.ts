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
  const sessionDeadlines = new Map<string, { maxIterations: number; startedAt: number; iterations: number }>()

  const dispose = ctx.provide('guard', {
    _active: true,
    checkRepeat(toolName: string, args: any): { isRepeat: boolean; message?: string } {
      // 委托给 repeatToolReminder（如果可用），提供更精细的重复检测
      try {
        const reminder = ctx.get('repeatToolReminder')
        if (reminder) {
          reminder.record('global', toolName, JSON.stringify(args))
          return reminder.check('global')
        }
      } catch (e) { console.warn('[guard-provider.ts]', e) }
      // 基础去重实现（5 秒窗口）
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

    /** Track session iterations and check deadline */
    setDeadline(sessionId: string, maxIterations: number) {
      sessionDeadlines.set(sessionId, { maxIterations, startedAt: Date.now(), iterations: 0 })
    },

    /** Increment iteration counter for a session */
    tick(sessionId: string) {
      const d = sessionDeadlines.get(sessionId)
      if (d) {
        d.iterations++
        return d.iterations
      }
      return 0
    },

    /** Check if session has exceeded its iteration deadline */
    checkDeadline(sessionId: string): { exceeded: boolean; remaining?: number } {
      const d = sessionDeadlines.get(sessionId)
      if (!d) return { exceeded: false }
      const remaining = d.maxIterations - d.iterations
      return { exceeded: d.iterations >= d.maxIterations, remaining: Math.max(0, remaining) }
    },

    /** Clear deadline for a session */
    clearDeadline(sessionId: string) {
      sessionDeadlines.delete(sessionId)
    },
  })

  // Composite dispose
  const compositeDispose = () => {
    callHistory.clear()
    sessionDeadlines.clear()
    dispose()
  }
  return compositeDispose
}
