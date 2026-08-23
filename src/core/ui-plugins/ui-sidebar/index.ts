// @ts-nocheck
/**
 * @codem/ui-sidebar — 侧边栏 UI 插件包
 *
 * 对标 DSH：组件同步导入，不用 React.lazy。
 */
import { Sidebar } from '../../../components/Sidebar'

export function apply(ctx: any) {
  const slots = ctx.get('slots')
  slots.register({ name: 'app.sidebar', id: 'default-sidebar', priority: 0 }, Sidebar)
}
