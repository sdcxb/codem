// @ts-nocheck
/**
 * @codem/uiLayout — UI Provider
 *
 * app.layout slot 已移除 — HubLayout 已由 ui-panels 注册到 app.skin-layout slot。
 * 此 provider 仅保留 service 注册。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiLayoutProvider: Plugin = (ctx: any) => {
  const s = {
    layouts: new Map([['default',{name:'Default',panels:['sidebar','conversation','details']}],['compact',{name:'Compact',panels:['conversation']}]]),
    get(name) { return this.layouts.get(name)||this.layouts.get('default') },
    set(name, layout) { this.layouts.set(name, layout) },
    list() { return [...this.layouts.values()] },
    render(layout) { return {type:'layout',config:layout||this.get('default')} },
  }

  const disp = ctx.provide('uiLayout', s)

  return () => {
    if (disp) disp()
  }
}
