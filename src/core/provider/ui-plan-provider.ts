// @ts-nocheck
/**
 * @codem/ui-plan — 计划模式 UI 插件
 *
 * 对标 DSH packages/client/ui-plan/src/client/index.ts。
 * 注册两个组件：
 * - PlanModeChip: Composer 内的模式切换 chip（对标 DSH PlanChip）
 * - PlanApprovalCard: exit_plan_mode 工具调用时的审批弹窗（已有组件）
 * 关闭此 Provider 后，两个 Slot 中的组件都被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行 apply。
 */
import { lazy } from 'react'
import type { Plugin } from '../cordis/src/index.ts'

const PlanModeChip = lazy(() => import('../../components/PlanModeChip'))
const PlanApprovalCard = lazy(() => import('../../components/PlanApprovalCard'))

export const uiPlanProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(plan) { return { type: 'plan-panel', plan } },
      async createPlan(steps) { const p = ctx.get('plans'); if (p && p.create) return p.create(steps); return { id: 'plan-' + Date.now(), steps, status: 'pending' } },
      async updateStep(planId, stepIdx, status) { const p = ctx.get('plans'); if (p && p.updateStep) return p.updateStep(planId, stepIdx, status); return { updated: true } },
      async getPlan(id) { const p = ctx.get('plans'); return p && p.get ? p.get(id) : null },
    }

    // Register React components to Slot — inject: ['slots'] 保证 slots 可用
    const slots = ctx.get('slots')
    const unregs: (() => void)[] = [
      slots.register({ name: 'app.plan-mode-chip', id: 'r8-planmodechip', priority: 5 }, PlanModeChip),
      slots.register({ name: 'app.plan-approval-card', id: 'r8-planapprovalcard', priority: 5 }, PlanApprovalCard),
    ]

    // 使用 slots.inject 声明消费依赖：
    // 只有 conversation.composer.bar 子 slot 存在时才注册（对标 DSH 模式）
    const injectUnreg = slots.inject('conversation.composer.bar', () =>
      slots.register({ name: 'conversation.composer.bar', id: 'r8-planmodechip-sub', priority: 5 }, PlanModeChip)
    )

    const disp = ctx.provide('uiPlan', s)

    // Composite dispose: clean up provide and slot registrations
    return () => {
      if (disp) disp()
      for (const u of unregs) { try { u() } catch (_e) { /* ignore */ } }
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
