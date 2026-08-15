// @ts-nocheck
/**
 * @codem/ui-misc — 杂项 UI 插件包
 *
 * 包含 GoalPanel/PlanPanel/JobsPanel/MonitorPanel/PetOverlay/FeedbackButtons/ModelSelector 等。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const PetOverlay = lazy(() => import('../../../components/PetOverlay'))
const FeedbackButtons = lazy(() => import('../../../components/FeedbackButtons'))
const ContextMonitor = lazy(() => import('../../../components/ContextMonitor'))
const PerformanceDashboard = lazy(() => import('../../../components/PerformanceDashboard'))
const TodoListDisplay = lazy(() => import('../../../components/TodoListDisplay'))

export function apply() {
  const ctx = useCtx()

  // 宠物覆盖层
  ctx.slots.register('app.overlay', PetOverlay, { order: 100 })

  // 消息反馈按钮
  ctx.slots.register('conversation.messages', FeedbackButtons, { order: 50 })

  // 监控面板
  ctx.slots.register('app.monitor', ContextMonitor)
  ctx.slots.register('app.monitor', PerformanceDashboard)

  // 目标面板
  ctx.slots.register('app.goal', TodoListDisplay)

  console.log('[ui-misc] Registered misc UI plugins')
}
