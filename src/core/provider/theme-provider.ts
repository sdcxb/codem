/**
 * Theme Provider 插件 — 可独立加载/卸载/热替换。
 *
 * ## 第 45 轮 D-16 修复：暴露的服务方法必须**真的存在**
 *
 * 旧实现（`@ts-nocheck` 掩盖）暴露了 `getCurrent/setTheme/listThemes/registerTheme/onThemeChange`
 * 五个方法，而 `ThemeManager` 上**一个都不存在**（它只有
 * `init/getSkin/getDreamConfig/setSkin/updateDreamConfig/setDreamBackground/onChange/getAvailableSkins`）。
 * 类型侧却按 `capabilities/index.ts:212-221` 的 `ThemeService` 声明，于是任何
 * `ctx.get('theme').setTheme(...)` 都是运行期 `TypeError`。
 *
 * 现在按**真实存在的 API** 暴露，并给出 `listThemes/registerTheme` 两个名字的**单实现别名**
 * （皮肤列表 = 主题列表；`registerTheme` 在这个模型下无法注册外部皮肤 —— 它是
 * Tauri 构建期注入的 CSS，运行期没有对应能力，因此**不暴露**它，宁可让调用方编译期就发现）。
 *
 * 同时在这里挂上"端口就绪 → 皮肤校正"的门（D-17，见 `theme-resync.ts`）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ThemeManager, readCachedSkin } from '../theme'
import { setupThemeSkinResync } from '../theme/theme-resync'
import type { SkinId } from '../theme/types'

export const themeProvider: Plugin = (ctx: any) => {
  // ThemeManager is a singleton instance, not a class — use directly
  const themeMgr = ThemeManager

  // D-17：端口注册后立刻用 DB 校正皮肤（幂等，重复调用无副作用）
  const teardownResync = setupThemeSkinResync()

  const dispose = ctx.provide('theme', {
    /** 当前皮肤（`default` / `hub` / `dream`） */
    getCurrent: (): SkinId => themeMgr.getSkin(),
    /** 切换皮肤并落库（同时更新首屏镜像） */
    setTheme: (name: SkinId): void => themeMgr.setSkin(name),
    /** 可选皮肤/主题列表（`ThemeService.listThemes` 的语义） */
    listThemes: () => themeMgr.getAvailableSkins().map((s) => ({ name: s.id, label: s.name })),
    /** 皮肤变化订阅（`ThemeService.onThemeChange` 的语义） */
    onThemeChange: (cb: (theme: string) => void): (() => void) => themeMgr.onChange(cb),
    /** 首屏镜像里的皮肤（DB 未就绪时的预测值），诊断用 */
    getFirstPaintSkin: (): SkinId | null => readCachedSkin(),
  })

  return () => {
    teardownResync()
    if (dispose) dispose()
  }
}
