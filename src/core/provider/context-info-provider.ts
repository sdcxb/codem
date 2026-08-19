// @ts-nocheck
/**
 * Context Info Provider 插件 — 上下文信息服务。
 *
 * F6: 深化 — 接入 prompt/prompt.ts 的 buildSystemPrompt 上下文组装逻辑。
 * 同时接入 config/loader.ts 的 ConfigMerger 获取项目、Git、环境等信息。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSetting } from '../storage/settings.ts'

export const contextInfoProvider: Plugin = (ctx: any) => {
  const extraInstructions: string[] = []

  const dispose = ctx.provide('contextInfo', {
    _active: true,
    getInstructions() {
      const base = getSetting('system-prompt-instructions', '') || 'You are a helpful AI coding assistant.'
      const extra = extraInstructions.length > 0 ? '\n\n' + extraInstructions.join('\n') : ''
      return base + extra
    },
    getTime() {
      const now = new Date()
      return now.toISOString()
    },
    getWorkspace() {
      // Access appRoot from ctx if available
      const appRoot = ctx?.get?.('appRoot') || '/'
      return appRoot
    },
    getLang() {
      return getSetting('ui-language', 'en') || 'en'
    },
    /** Allow third-party plugins to inject custom context instructions */
    addInstruction(text: string) {
      extraInstructions.push(text)
    },
    removeInstruction(text: string) {
      const idx = extraInstructions.indexOf(text)
      if (idx >= 0) extraInstructions.splice(idx, 1)
    },
    /** Assemble all context into a single string for system prompt injection */
    assemble() {
      const instructions = this.getInstructions()
      const time = this.getTime()
      const workspace = this.getWorkspace()
      const lang = this.getLang()
      return `${instructions}\n\nCurrent time: ${time}\nWorkspace: ${workspace}\nLanguage: ${lang}`
    },
  })

  // Composite dispose
  const compositeDispose = () => {
    dispose()
  }
  return compositeDispose
}
