// @ts-nocheck
/**
 * @codem/uiSubagent — UI Provider
 *
 * app.subagent slot 现在在 App.tsx 中通过 SlotBridge 消费（fallback 为 null）。
 * 使用 inject 声明依赖 slots 服务，框架保证 ctx.get('slots') 可用。
 */
import { lazy } from 'react'
import type { Plugin } from '../cordis/src/index.ts'

const DelegationPanel = lazy(() => import('../../components/DelegationPanel'))

export const uiSubagentProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render() { const sub=ctx.get('subagent'); const agents=sub&&sub.list?sub.list():[]; return {type:'subagent-panel',agents} },
      async create(config) { const sub=ctx.get('subagent'); if(sub&&sub.create)return sub.create(config); return {id:'sub-'+Date.now(),...config} },
      async terminate(id) { const sub=ctx.get('subagent'); if(sub&&sub.remove)return sub.remove(id); return true },
    }

    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.subagent', id: 'r8-delegationpanel', priority: 5 }, DelegationPanel)

    const disp = ctx.provide('uiSubagent', s)

    return () => {
      if (disp) disp()
      if (unreg) unreg()
    }
  },
  { inject: ['slots'] }
)
