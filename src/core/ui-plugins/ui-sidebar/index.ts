// @ts-nocheck
/**
 * @codem/ui-sidebar — 侧边栏 UI 插件包
 *
 * 将 Sidebar.tsx 组件注册到 ctx.slots['app.sidebar']。
 * 组件来源可替换：其他插件可以注册更高优先级的组件来替换侧边栏。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const Sidebar = lazy(() => import('../../../components/Sidebar'))

export function apply() {
  const ctx = useCtx()
  ctx.slots.register({ name: 'app.sidebar', id: 'default-sidebar', priority: 0 }, Sidebar)
}
