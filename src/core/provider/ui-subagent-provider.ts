// @ts-nocheck
/**
 * @codem/uiSubagent — UI Provider
 *
 * app.subagent slot 现在在 App.tsx 中通过 SlotBridge 消费（fallback 为 null）。
 * 使用 inject 声明依赖 slots 服务，框架保证 ctx.get('slots') 可用。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiSubagentProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render() { const sub=ctx.get('subagent'); const agents=sub&&sub.list?sub.list():[]; return {type:'subagent-panel',agents} },
      async create(config) { const sub=ctx.get('subagent'); if(sub&&sub.create)return sub.create(config); return {id:'sub-'+Date.now(),...config} },
      async terminate(id) { const sub=ctx.get('subagent'); if(sub&&sub.remove)return sub.remove(id); return true },
    }

    // 不在此注册 DelegationPanel 到 app.subagent slot。
    // DelegationPanel 是模态弹窗，需要 onClose prop，
    // 而 App.tsx 中的 SlotBridge 以无 props 方式消费该 slot，会导致弹窗自动弹出且无法关闭。

    const disp = ctx.provide('uiSubagent', s)

    return () => {
      if (disp) disp()
    }
  },
  { inject: ['slots'] }
)
