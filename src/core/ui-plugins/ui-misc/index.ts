// @ts-nocheck
/**
 * @codem/ui-misc — 杂项 UI 插件包
 *
 * 包含 PetOverlay/FeedbackButtons/ContextMonitor/TodoListDisplay 等。
 * 使用 inject 声明依赖 slots 服务。
 */
import { lazy } from 'react'

const PetOverlay = lazy(() => import('../../../components/PetOverlay'))
const ContextMonitor = lazy(() => import('../../../components/ContextMonitor'))
const PerformanceDashboard = lazy(() => import('../../../components/PerformanceDashboard'))
const TodoListDisplay = lazy(() => import('../../../components/TodoListDisplay'))

export function apply(ctx: any) {
  const slots = ctx.get('slots')

  // 宠物覆盖层 — list 类型 slot
  slots.register({ name: 'app.overlay', id: 'pet-overlay', order: 100, priority: 0 }, PetOverlay)

  // 监控面板
  slots.register({ name: 'app.monitor', id: 'context-monitor', priority: 0 }, ContextMonitor)
  slots.register({ name: 'app.performance-dashboard', id: 'perf-dash', priority: 0 }, PerformanceDashboard)

  // 目标面板 — app.goal slot 现在在 App.tsx 中通过 SlotBridge 消费
  slots.register({ name: 'app.goal', id: 'todo-display', priority: 0 }, TodoListDisplay)

  console.log('[ui-misc] Registered misc UI plugins')
}
