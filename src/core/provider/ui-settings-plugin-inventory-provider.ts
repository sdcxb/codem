// @ts-nocheck
/**
 * @codem/uiSettingsPluginInventory — UI Provider
 *
 * app.plugin-market slot 已移除 — PluginManager 已通过 app.plugin-manager slot 消费。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiSettingsPluginInventoryProvider: Plugin = (ctx: any) => {
  const s = {
    render() { const reg=ctx.get('pluginRegistry'); const plugins=reg?reg.list():[]; return {type:'settings-plugin-inventory',plugins} },
    async install(name) { const b=ctx.get('bundle'); if(b&&b.install)return b.install(name); return {installed:true,name} },
    async uninstall(name) { const b=ctx.get('bundle'); if(b&&b.uninstall)return b.uninstall(name); return true },
    async enable(name) { return {enabled:true,name} },
    async disable(name) { return {disabled:true,name} },
  }

  const disp = ctx.provide('uiSettingsPluginInventory', s)

  return () => {
    if (disp) disp()
  }
}
