// @ts-nocheck
/**
 * @codem/time-context — 时间上下文注入，给 Agent 感知当前时间和时区。
 *
 * 参考自 DSH (DeepSeek Harness) packages/context/time-context/src/index.ts:
 *   - 注册为 system-prompt 的动态 context provider
 *   - buildContext() 返回格式化的时间字符串供 LLM 感知
 *   - 支持 relative time formatting
 */
import type { Plugin } from '../cordis/src/index.ts'

export const timeContextProvider: Plugin = (ctx: any) => {
  const service = {
    /** 获取时区 */
    getTimezone(): string {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    },

    /** 当前 ISO 时间 */
    now(): string {
      return new Date().toISOString()
    },

    /** Unix 时间戳 */
    timestamp(): number {
      return Date.now()
    },

    /**
     * 构建时间上下文 — 参考 DSH time-context buildContext()
     * 返回模型可读的时间信息字符串
     */
    buildContext(): string {
      const now = new Date()
      const tz = this.getTimezone()
      const dateStr = now.toDateString()
      const timeStr = now.toTimeString()
      const isoStr = now.toISOString()
      const localeStr = now.toLocaleString()

      return [
        `Current time: ${isoStr}`,
        `Timezone: ${tz}`,
        `Date: ${dateStr}`,
        `Time: ${timeStr}`,
        `Locale: ${localeStr}`,
      ].join('\n')
    },

    /**
     * 格式化时间 — 参考 DSH time-context format()
     */
    format(date: Date | string | number = new Date(), opts: any = {}): string {
      const d = date instanceof Date ? date : new Date(date)
      return d.toLocaleString(opts.locale || 'en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
        ...opts,
      })
    },

    /**
     * 相对时间 — "3 分钟前" / "in 2 hours"
     */
    relative(date: Date | string | number): string {
      const d = date instanceof Date ? date : new Date(date)
      const diff = d.getTime() - Date.now()
      const abs = Math.abs(diff)
      const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

      if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second')
      if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
      if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
      if (abs < 604_800_000) return rtf.format(Math.round(diff / 86_400_000), 'day')
      return rtf.format(Math.round(diff / 604_800_000), 'week')
    },

    /**
     * 注册为 system-prompt 的 context provider
     * 参考 DSH 模式：ctx.systemPrompt.context({ name, order, text: provider })
     */
    registerToSystemPrompt(systemPromptSvc: any): void {
      if (systemPromptSvc?.addContext) {
        systemPromptSvc.addContext({
          name: 'time-context',
          order: 50,
          text: () => this.buildContext(),
        })
      }
    },
  }

  // 自动注册到 system-prompt 服务（如果可用）
  const sp = ctx.get('systemPrompt')
  if (sp) {
    service.registerToSystemPrompt(sp)
  } else {
    // 延迟注册：监听 systemPrompt 变得可用
    ctx.effect?.(() => {
      const sp2 = ctx.get('systemPrompt')
      if (sp2) service.registerToSystemPrompt(sp2)
    }, 'time-context: register to system-prompt')
  }

  return ctx.provide('timeContext', service)
}
