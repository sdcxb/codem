// @ts-nocheck
/**
 * @codem/ui-settings — 设置 UI 插件包
 *
 * 将 SettingsPanel 注册到 ctx.slots['app.settings']（keyed 模式）。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const SettingsPanel = lazy(() => import('../../../components/SettingsPanel'))
const GeneralSettings = lazy(() => import('../../../components/SettingsParts'))
const ModelProfilePanel = lazy(() => import('../../../components/ModelProfilePanel'))
const OllamaSettings = lazy(() => import('../../../components/OllamaSettingsPanel'))

export function apply() {
  const ctx = useCtx()

  ctx.slots.register('app.settings', SettingsPanel, { key: 'general' })
  ctx.slots.register('app.settings', GeneralSettings, { key: 'general' })
  ctx.slots.register('app.settings', ModelProfilePanel, { key: 'models' })
  ctx.slots.register('app.settings', OllamaSettings, { key: 'models' })
}
