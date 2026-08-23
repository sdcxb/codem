// @ts-nocheck
/**
 * @codem/ui-settings — 设置 UI 插件包
 *
 * 对标 DSH：组件同步导入，不用 React.lazy。
 */
import { SettingsPanel } from '../../../components/SettingsPanel'

export function apply(ctx: any) {
  const slots = ctx.get('slots')
  slots.register({ name: 'app.settings', id: 'default-settings', priority: 0 }, SettingsPanel)
}
