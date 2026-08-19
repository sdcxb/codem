// @ts-nocheck
/**
 * @codem/ui-goal — 目标指示条 UI 插件
 *
 * 对标 DSH packages/client/ui-goal/src/client/index.ts。
 * 注册 GoalBar 组件到 app.goal-bar slot。
 * GoalBar 在 Composer 输入区上方显示当前目标（如果设置了的话）。
 *
 * 语义修正：
 * - uiGoal → GoalBar（目标指示条），不是 PlanApprovalCard
 * - PlanApprovalCard 由 ui-plan-provider.ts 注册到 app.plan-approval-card slot
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import { lazy } from 'react'
import type { Plugin } from '../cordis/src/index.ts'

const GoalBar = lazy(() => import('../../components/GoalBar'))

export const uiGoalProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(goal) { return { type: 'goal-bar', goal } },
      async setGoal(goal) { const driver = ctx.get('goalRoundDriver'); if (driver && driver.setGoal) return driver.setGoal(goal); return { id: 'goal-' + Date.now(), ...goal } },
      async getGoals() { const driver = ctx.get('goalRoundDriver'); return driver && driver.getGoals ? driver.getGoals() : [] },
    }

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.goal-bar', id: 'r8-goalbar', priority: 5 }, GoalBar)

    // 使用 slots.inject 声明消费依赖：conversation.composer.dock 存在时注册
    const injectUnreg = slots.inject('conversation.composer.dock', () =>
      slots.register({ name: 'conversation.composer.dock', id: 'r8-goalbar-sub', priority: 5 }, GoalBar)
    )

    const disp = ctx.provide('uiGoal', s)

    // Composite dispose: clean up both provide and slot registration
    return () => {
      if (disp) disp()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
