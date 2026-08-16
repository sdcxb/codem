// @ts-nocheck
/**
 * Plans Provider 插件 — 结构化任务计划管理。
 *
 * 功能链：
 * - 上游：exit_plan_mode 工具（src/core/llm/tools/exit-plan-mode.ts）审批通过后存入计划
 *         AgenticLoop.planSteps()（agentic-loop.ts L377-L427）LLM 生成 StepPlan[]
 * - 下游：step_progress 事件 → UI 进度显示
 * - 接入点：exit-plan-mode.ts L90-L96 → 审批通过后调用 ctx.plans.create()
 *           agentic-loop.ts L536-L539 → planState 改为从 ctx.plans 读取
 *           agentic-loop.ts L633 → step_progress 事件改为从 ctx.plans.get() 读取
 *           declare-slots.ts → 已有 app.plan Slot 声明
 *
 * 当前为空壳实现，真实实现需：
 * 1. 包装 goal.ts 的 SQLite 存储（或独立 plans 表）
 * 2. exit_plan_mode 工具审批通过后 → ctx.plans.create(title, steps) 持久化计划
 * 3. AgenticLoop.planSteps() 结果 → ctx.plans.create() 而非临时变量
 * 4. 每次迭代结束时 → ctx.plans.updateStep(planId, iteration - 1, true) 标记完成
 * 5. UI 从 ctx.plans.get(planId) 读取进度
 * 6. 新增 plan_tools.ts（create_plan/get_plan/update_plan_step），让 LLM 可管理计划
 */
import type { Plugin } from '../cordis/src/index.ts'

export const plansProvider: Plugin = (ctx: any) => {
  const plansStore: Array<{ id: string; title: string; steps: Array<{ text: string; done: boolean }> }> = []

  const dispose = ctx.provide('plans', {
    create(title: string, steps: string[]): string {
      const id = crypto.randomUUID()
      plansStore.push({ id, title, steps: steps.map(text => ({ text, done: false })) })
      return id
    },
    get(planId: string): { id: string; title: string; steps: Array<{ text: string; done: boolean }> } | undefined {
      return plansStore.find(p => p.id === planId)
    },
    list(): Array<{ id: string; title: string; progress: number }> {
      return plansStore.map(p => ({
        id: p.id,
        title: p.title,
        progress: p.steps.length > 0 ? p.steps.filter(s => s.done).length / p.steps.length : 0,
      }))
    },
    updateStep(planId: string, stepIndex: number, done: boolean): void {
      const p = plansStore.find(p => p.id === planId)
      if (p && p.steps[stepIndex]) p.steps[stepIndex].done = done
    },
    remove(planId: string): void {
      const idx = plansStore.findIndex(p => p.id === planId)
      if (idx >= 0) plansStore.splice(idx, 1)
    },
  })

  return dispose
}
