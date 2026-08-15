// @ts-nocheck
/**
 * Theme Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ThemeManager } from '../theme'

export const themeProvider: Plugin = (ctx: any) => {
  const themeMgr = new ThemeManager()

  const dispose = ctx.provide('theme', {
    getCurrent: () => themeMgr.getCurrent(),
    setTheme: (name: string) => themeMgr.setTheme(name),
    listThemes: () => themeMgr.listThemes(),
    registerTheme: (name: string, css: string) => themeMgr.registerTheme(name, css),
    onThemeChange: (cb: (theme: string) => void) => themeMgr.onThemeChange(cb),
  })

  return dispose
}
