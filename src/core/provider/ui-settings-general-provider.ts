// @ts-nocheck
/**
 * @codem/uiSettingsGeneral — UI Provider
 *
 * app.settings.general slot 已移除 — SettingsPanel 已通过 app.settings slot 消费。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiSettingsGeneralProvider: Plugin = (ctx: any) => {
  const s = {
    render(settings) { return {type:'settings-general',settings} },
    async get() { const st=ctx.get('settings'); return st&&st.getAll?st.getAll():{} },
    async set(key, value) { const st=ctx.get('settings'); if(st&&st.set)return st.set(key,value); return {set:true} },
    async reset() { return {reset:true} },
  }

  const disp = ctx.provide('uiSettingsGeneral', s)

  return () => {
    if (disp) disp()
  }
}
