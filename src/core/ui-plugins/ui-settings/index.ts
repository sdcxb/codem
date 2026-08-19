// @ts-nocheck
/**
 * @codem/ui-settings — 设置 UI 插件包
 *
 * 将 SettingsPanel 注册到 ctx.slots['app.settings']。
 * 使用 single 模式（整个设置面板作为一个整体注册）。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const SettingsPanel = lazy(() => import('../../../components/SettingsPanel'))

export function apply() {
  const ctx = useCtx()
  const slots = ctx.get('slots')

  slots.register({ name: 'app.settings', id: 'default-settings', priority: 0 }, SettingsPanel)
}
