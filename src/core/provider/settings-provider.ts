// @ts-nocheck
/**
 * Settings Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSettingsManager } from '../settings/settings'

export const settingsProvider: Plugin = (ctx: any) => {
  const settingsMgr = getSettingsManager()

  const dispose = ctx.provide('settings', {
    get: <T>(key: string, defaultValue?: T) => settingsMgr.get(key, defaultValue),
    set: <T>(key: string, value: T) => settingsMgr.set(key, value),
    getAll: () => settingsMgr.getAll(),
    watch: (key: string, cb: (value: any) => void) => settingsMgr.watch(key, cb),
  })

  return dispose
}
