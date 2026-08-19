// @ts-nocheck
/**
 * @codem/uiSettingsPlugins — UI Provider
 *
 * app.settings.plugins slot 已移除 — SettingsPanel 已通过 app.settings slot 消费。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiSettingsPluginsProvider: Plugin = (ctx: any) => {
  const s = {
    render() { const reg=ctx.get('pluginRegistry'); const plugins=reg?reg.list():[]; return {type:'settings-plugins',plugins:plugins.filter(p=>!p.core)} },
    async toggle(name, enabled) { return {name,enabled,toggled:true} },
    async configure(name, config) { return {name,config,saved:true} },
  }

  const disp = ctx.provide('uiSettingsPlugins', s)

  return () => {
    if (disp) disp()
  }
}
