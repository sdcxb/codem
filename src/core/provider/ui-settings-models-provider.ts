// @ts-nocheck
/**
 * @codem/uiSettingsModels — UI Provider
 *
 * app.settings.models slot 已移除 — SettingsPanel 已通过 app.settings slot 消费。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiSettingsModelsProvider: Plugin = (ctx: any) => {
  const s = {
    render() { const mp=ctx.get('modelProfile'); const models=mp&&mp.list?mp.list():[]; return {type:'settings-models',models} },
    async addModel(config) { const mp=ctx.get('modelProfile'); if(mp&&mp.add)return mp.add(config); return {id:'model-'+Date.now(),...config} },
    async removeModel(id) { const mp=ctx.get('modelProfile'); if(mp&&mp.remove)return mp.remove(id); return true },
    async setDefault(id) { const mp=ctx.get('modelProfile'); if(mp&&mp.setDefault)return mp.setDefault(id); return true },
  }

  const disp = ctx.provide('uiSettingsModels', s)

  return () => {
    if (disp) disp()
  }
}
