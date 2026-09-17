// @ts-nocheck
/**
 * Context Info Provider 插件 — 上下文信息服务。
 *
 * F6: 深化 — 接入 prompt/prompt.ts 的 buildSystemPrompt 上下文组装逻辑。
 * 同时接入 config/loader.ts 的 ConfigMerger 获取项目、Git、环境等信息。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSetting } from '../storage/settings.ts'
// 第 45 轮 D-24：语言兜底必须与应用级默认一致（`DEFAULT_LANG = "zh"`），
// 顺手复用 `getLang()` 的"读不到不缓存 + 端口就绪后重同步"逻辑
import { getLang, DEFAULT_LANG } from '../i18n/lang.ts'

export const contextInfoProvider: Plugin = (ctx: any) => {
  const extraInstructions: string[] = []

  const dispose = ctx.provide('contextInfo', {
    _active: true,
    getInstructions() {
      // 第 61 波：原来是 getSetting('system-prompt-instructions', '') —— getSetting 只接受 1 个参数，
      // 第二个"默认值"会被**静默忽略**（本文件带 @ts-nocheck，所以类型检查没拦住）。
      // 默认值本来就由后面的 `||` 兜住，这里直接去掉多余实参。
      const base = getSetting('system-prompt-instructions') || 'You are a helpful AI coding assistant.'
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
      /**
       * 第 45 轮 D-24：这里原来是 `getSetting('ui-language') || 'en'`。
       *
       * `ui-language` 全仓没有写入方（永远取兜底值），而那个兜底值是 `'en'` ——
       * 与全应用的默认语言 `DEFAULT_LANG = 'zh'`（`i18n/lang.ts:12`）**相反**：
       * 一个英文之外的语义错误（默认中文的应用会对第三方插件宣告 `Language: en`）。
       *
       * 现在保留 `ui-language` 这条兼容通道（设置了就优先），兜底改成 `getLang()`
       * （= DB `codem-language` → 默认 `zh`，且首帧读不到时不会把默认值缓存住）。
       */
      const explicit = getSetting('ui-language')
      if (explicit === 'zh' || explicit === 'en') return explicit
      try {
        return getLang()
      } catch {
        return DEFAULT_LANG
      }
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
