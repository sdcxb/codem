// @ts-nocheck
/**
 * i18n Provider 插件 — 包装真实国际化服务并接入 ctx。
 *
 * 真实实现源：src/core/i18n/lang.ts（getLang() + Language 类型）
 *
 * 接入点：
 * - tools.ts 通过 ctx.get('i18n').getLang() 获取当前语言
 * - 替代直接 import { getLang }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getLang } from '../i18n/lang.ts'

export const i18nProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('i18n', {
    getLang(): string {
      return getLang()
    },
    t(key: string, params?: any): string {
      // 委托给 i18n 系统的翻译函数
      // 当前 i18n/lang.ts 只有 getLang，翻译函数在 locale 模块中
      // 保留接口，待 i18n 系统完善后接入
      return key
    },
  })

  return dispose
}
