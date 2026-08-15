// @ts-nocheck
/**
 * @codem/ui-misc — 杂项 UI 插件包
 *
 * 包含 PetOverlay/FeedbackButtons/ContextMonitor/TodoListDisplay 等。
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

  // 宠物覆盖层 — list 类型 slot
  ctx.slots.register({ name: 'app.overlay', id: 'pet-overlay', order: 100, priority: 0 }, PetOverlay)

  // 监控面板
  ctx.slots.register({ name: 'app.monitor', id: 'context-monitor', priority: 0 }, ContextMonitor)
  ctx.slots.register({ name: 'app.performance-dashboard', id: 'perf-dash', priority: 0 }, PerformanceDashboard)

  // 目标面板
  ctx.slots.register({ name: 'app.goal', id: 'todo-display', priority: 0 }, TodoListDisplay)

  console.log('[ui-misc] Registered misc UI plugins')
}
