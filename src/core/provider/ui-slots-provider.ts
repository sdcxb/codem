// @ts-nocheck
/**
 * @codem/uiSlots — UI Provider with Slot registration
 *
 * 参考 DSH (DeepSeek Harness) packages/client/ui-goal/src/client/index.ts 的模式:
 * Provider 同时通过 ctx.provide() 注册服务接口 和 ctx.get('slots').register() 注册 React 组件。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 自动回退到 fallback 组件。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { PluginManager } from '../../components/PluginManager'

export const uiSlotsProvider: Plugin = (ctx: any) => {
  const s = {
    render() { const slots=ctx.get('slots'); const list=slots&&slots.list?slots.list():[]; return {type:'slots-panel',slots:list} },
    async register(slotId, plugin) { const slots=ctx.get('slots'); if(slots&&slots.register)return slots.register(slotId,plugin); return {registered:true} },
    async unregister(slotId, pluginName) { const slots=ctx.get('slots'); if(slots&&slots.unregister)return slots.unregister(slotId,pluginName); return true },
  }

  // Register React component to Slot — 参考 DSH ui-goal/src/client/index.ts:51
  const slots = ctx.get('slots')
  let unreg: (() => void) | undefined
  if (slots && slots.register) {
    unreg = slots.register({ name: 'app.plugin-manager', id: 'r8-pluginmanager', priority: 5 }, PluginManager)
  }

  const disp = ctx.provide('uiSlots', s)

  // Composite dispose: clean up both provide and slot registration
  return () => {
    if (disp) disp()
    if (unreg) unreg()
  }
}
