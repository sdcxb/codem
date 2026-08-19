// @ts-nocheck
/**
 * @codem/uiWorkflowRun — UI Provider
 *
 * app.workflow-run slot 现在在 App.tsx 中通过 SlotBridge 消费（fallback 为 null）。
 * 使用 inject 声明依赖 slots 服务。
 */
import { lazy } from 'react'
import type { Plugin } from '../cordis/src/index.ts'

const ActivityTimeline = lazy(() => import('../../components/ActivityTimeline'))

export const uiWorkflowRunProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(run) { return {type:'workflow-run-panel',run} },
      async start(config) { const wf=ctx.get('workflow'); if(wf&&wf.start)return wf.start(config); return {id:'wf-'+Date.now(),status:'running'} },
      async getStatus(id) { const wf=ctx.get('workflow'); return wf&&wf.getStatus?wf.getStatus(id):{status:'unknown'} },
      async cancel(id) { const wf=ctx.get('workflow'); if(wf&&wf.cancel)return wf.cancel(id); return true },
    }

    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.workflow-run', id: 'r8-activitytimeline', priority: 5 }, ActivityTimeline)

    const disp = ctx.provide('uiWorkflowRun', s)

    return () => {
      if (disp) disp()
      if (unreg) unreg()
    }
  },
  { inject: ['slots'] }
)
