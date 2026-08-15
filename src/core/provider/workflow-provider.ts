// @ts-nocheck
/**
 * Workflow Provider 插件 — 工作流引擎，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const workflowProvider: Plugin = (ctx: any) => {
  const workflows = new Map<string, any>()

  const dispose = ctx.provide('workflow', {
    create(steps: any[]) {
      const id = crypto.randomUUID()
      workflows.set(id, { id, steps, status: 'pending', step: 0, results: [] })
      return id
    },
    async run(workflowId: string) {
      const wf = workflows.get(workflowId)
      if (!wf) return { success: false, results: [] }
      wf.status = 'running'
      for (let i = 0; i < wf.steps.length; i++) {
        wf.step = i
        try {
          const result = await wf.steps[i].fn()
          wf.results.push(result)
        } catch { wf.status = 'failed'; return { success: false, results: wf.results } }
      }
      wf.status = 'completed'
      return { success: true, results: wf.results }
    },
    get(workflowId: string) {
      const wf = workflows.get(workflowId)
      return wf ? { id: wf.id, status: wf.status, step: wf.step } : undefined
    },
  })

  return dispose
}
