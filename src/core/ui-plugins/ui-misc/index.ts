// @ts-nocheck
/**
 * @codem/ui-misc — 杂项 UI 插件包
 *
 * 对标 DSH：组件同步导入，不用 React.lazy。
 */
import { PetOverlay } from '../../../components/PetOverlay'
import { ContextMonitor } from '../../../components/ContextMonitor'
import { PerformanceDashboard } from '../../../components/PerformanceDashboard'

export function apply(ctx: any) {
  const slots = ctx.get('slots')

  // 宠物覆盖层 — list 类型 slot
  slots.register({ name: 'app.overlay', id: 'pet-overlay', order: 100, priority: 0 }, PetOverlay)

  // 监控面板
  slots.register({ name: 'app.monitor', id: 'context-monitor', priority: 0 }, ContextMonitor)
  slots.register({ name: 'app.performance-dashboard', id: 'perf-dash', priority: 0 }, PerformanceDashboard)

  console.log('[ui-misc] Registered misc UI plugins')
}
