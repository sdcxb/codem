// @ts-nocheck
/**
 * @codem/uiCordis — UI Provider
 *
 * app.cordis slot 已移除 — PluginManager 已由 ui-panels 注册到 app.plugin-manager slot。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiCordisProvider: Plugin = (ctx: any) => {
  const s = {
    render() { const reg=ctx.get('pluginRegistry'); const plugins=reg?reg.list():[]; return {type:'cordis-panel',plugins} },
    getServiceList() { return [{name:'llm',status:'active'},{name:'tools',status:'active'},{name:'session',status:'active'}] },
    async togglePlugin(name, enabled) { return {name,enabled,toggled:true} },
  }

  const disp = ctx.provide('uiCordis', s)

  return () => {
    if (disp) disp()
  }
}
