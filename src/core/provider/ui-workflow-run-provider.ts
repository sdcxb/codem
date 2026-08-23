// @ts-nocheck
/**
 * @codem/uiWorkflowRun — UI Provider
 *
 * app.workflow-run slot 现在在 App.tsx 中通过 SlotBridge 消费（fallback 为 null）。
 * 使用 inject 声明依赖 slots 服务。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiWorkflowRunProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(run) { return {type:'workflow-run-panel',run} },
      async start(config) { const wf=ctx.get('workflow'); if(wf&&wf.start)return wf.start(config); return {id:'wf-'+Date.now(),status:'running'} },
      async getStatus(id) { const wf=ctx.get('workflow'); return wf&&wf.getStatus?wf.getStatus(id):{status:'unknown'} },
      async cancel(id) { const wf=ctx.get('workflow'); if(wf&&wf.cancel)return wf.cancel(id); return true },
    }

    // 不在此注册 ActivityTimeline 到 app.workflow-run slot。
    // ActivityTimeline 需要 items prop，
    // 而 App.tsx 中的 SlotBridge 以无 props 方式消费该 slot，会导致崩溃。
    // ActivityTimeline 应通过 TrajectoryPanel 等内部路径使用。

    const disp = ctx.provide('uiWorkflowRun', s)

    return () => {
      if (disp) disp()
    }
  },
  { inject: ['slots'] }
)
