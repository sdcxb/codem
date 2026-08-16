// @ts-nocheck
/**
 * Preset Provider 插件 — 配置预设管理。
 *
 * 功能链：
 * - 上游：Settings UI → 用户选择预设 → ctx.preset.apply(name)
 * - 下游：SettingsManager — 批量设置值
 * - 接入点：settings.ts 的 UserSettings + PolicySettings 分散预设统一为 preset 加载/保存
 *           Settings UI 增加"预设管理"面板
 *
 * 当前为空壳实现，真实实现需：
 * 1. ctx.preset.save('strict_security', { permissions: [...], telemetry: false }) 批量保存设置
 * 2. ctx.preset.apply('strict_security') 批量应用设置到 SettingsManager
 * 3. Settings UI 增加"预设管理"面板
 */
import type { Plugin } from '../cordis/src/index.ts'

export const presetProvider: Plugin = (ctx: any) => {
  const presets = new Map<string, any>()

  const dispose = ctx.provide('preset', {
    async load(name: string): Promise<any> {
      return presets.get(name)
    },
    async save(name: string, config: any): Promise<void> {
      presets.set(name, config)
    },
    list(): Array<{ name: string }> {
      return [...presets.keys()].map(name => ({ name }))
    },
    async apply(name: string): Promise<void> {
      const config = presets.get(name)
      if (config) {
        console.log(`[preset] Applied preset: ${name}`)
        // TODO: 将 config 中的值批量应用到 SettingsManager
        // if (ctx.settings) { for (const [k, v] of Object.entries(config)) ctx.settings.set(k, v) }
      }
    },
  })

  return dispose
}
