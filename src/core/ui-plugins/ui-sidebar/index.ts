// @ts-nocheck
/**
 * @codem/ui-sidebar — 侧边栏 UI 插件包
 *
 * 将 Sidebar.tsx 组件注册到 ctx.slots['app.sidebar']。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const Sidebar = lazy(() => import('../../../components/Sidebar'))

export function apply() {
  const ctx = useCtx()
  ctx.slots.register('app.sidebar', Sidebar)
}
