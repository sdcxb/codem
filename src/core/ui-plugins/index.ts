// @ts-nocheck
/**
 * UI 插件包入口 — 导出所有 UI 插件包。
 *
 * 在 App.tsx 的 Cordis Context 初始化时加载此文件，
 * 所有 UI 组件自动注册到 Slot Registry。
 */

import type { Context, Plugin } from '../cordis/src/index.ts'
import { declareAppSlots } from '../slots/declare-slots.ts'
import './slots.ts'  // 声明所有 UI 槽位类型

// 导入所有 UI 插件包
import { apply as sidebarApply } from './ui-sidebar/index.ts'
import { apply as conversationApply } from './ui-conversation/index.ts'
import { apply as toolApply } from './ui-tool/index.ts'
import { apply as settingsApply } from './ui-settings/index.ts'
import { apply as themeApply } from './ui-theme/index.ts'
import { apply as miscApply } from './ui-misc/index.ts'
import { apply as panelsApply } from './ui-panels/index.ts'
import { apply as marketApply } from './ui-market/index.ts'
import { apply as skinDefaultApply } from './ui-skin-default/index.ts'
import { apply as skinPetApply } from './ui-skin-pet/index.ts'
import { apply as uiPetApply } from './ui-pet/index.ts'
import { apply as cordisApply } from './ui-cordis/index.tsx'

// 导入 UI Provider — 对标 DSH 的 ui-* 插件包
// 这些 provider 同时注册服务和 slot 组件
import { uiGoalProvider } from '../provider/ui-goal-provider'
import { uiJobsProvider } from '../provider/ui-jobs-provider'
import { uiPlanProvider } from '../provider/ui-plan-provider'
import { uiModelSelectionProvider } from '../provider/ui-model-selection-provider'
import { uiPermissionPresetsProvider } from '../provider/ui-permission-presets-provider'
import { uiTrajectoryProvider } from '../provider/ui-trajectory-provider'
import { uiDeliverablesProvider } from '../provider/ui-deliverables-provider'
import { uiSubagentProvider } from '../provider/ui-subagent-provider'
import { uiUserQuestionsProvider } from '../provider/ui-user-questions-provider'
import { uiWorkflowRunProvider } from '../provider/ui-workflow-run-provider'
import { uiAttachmentProvider } from '../provider/ui-attachment-provider'
import { uiWorkspaceProvider } from '../provider/ui-workspace-provider'
import { uiSettingsGeneralProvider } from '../provider/ui-settings-general-provider'
import { uiSettingsModelsProvider } from '../provider/ui-settings-models-provider'
import { uiSettingsPluginInventoryProvider } from '../provider/ui-settings-plugin-inventory-provider'
import { uiSettingsPluginsProvider } from '../provider/ui-settings-plugins-provider'
import { uiSlotsProvider } from '../provider/ui-slots-provider'
import { uiLayoutProvider } from '../provider/ui-layout-provider'
import { uiDirectoryPickerProvider } from '../provider/ui-directory-picker-provider'
import { uiMessageFeedbackProvider } from '../provider/ui-message-feedback-provider'

/**
 * UI 插件聚合器 — 加载所有 UI 插件包。
 * 在 Cordis Context 启动后调用。
 */
export function loadUIPlugins(ctx: Context) {
  // 设置全局 Context — 通过参数传入，而非 require/import consumer 模块。
  // consumer 的 setActiveContext 已在 getCordisContext() 中由 App.tsx 调用，
  // 此处不需要重复设置。Cordis Context 通过参数传递，遵循"一切皆插件"原则。

  // 先声明所有 App 级别的 Slot
  declareAppSlots(ctx)

  // 按顺序加载 UI 插件
  // 对标 DSH 的 bundle 加载顺序：theme 先于其他 UI 插件，
  // panels/cordis 在 conversation 之后（它们注册到 app 级别 slot）
  const plugins = [
    { name: 'ui-theme', apply: themeApply },
    { name: 'ui-sidebar', apply: sidebarApply },
    { name: 'ui-conversation', apply: conversationApply },
    { name: 'ui-tool', apply: toolApply },
    { name: 'ui-settings', apply: settingsApply },
    { name: 'ui-misc', apply: miscApply },
    { name: 'ui-panels', apply: panelsApply },
    { name: 'ui-cordis', apply: cordisApply },
    { name: 'ui-market', apply: marketApply },
    { name: 'ui-skin-default', apply: skinDefaultApply },
    { name: 'ui-skin-pet', apply: skinPetApply },
    { name: 'ui-pet', apply: uiPetApply },
  ]

  for (const { name, apply } of plugins) {
    try {
      // 通过 ctx.plugin() 注册为正式 Cordis 插件，
      // 让 Cordis 的 fiber 机制管理依赖注入和生命周期。
      // apply 函数接收 fiber ctx 参数，ctx.get('slots') 在 fiber 上下文中执行，
      // Cordis 确保 inject 声明的依赖全部 ACTIVE 后才调用 apply。
      ctx.plugin({ inject: ['slots'], apply: (pluginCtx: any) => apply(pluginCtx) } as any)
      console.log(`[UI Plugins] Loaded: ${name}`)
    } catch (err) {
      console.warn(`[UI Plugins] Failed to load ${name}:`, err)
    }
  }

  // UI Provider — 对标 DSH 的 ui-* 插件包
  // 这些 provider 同时注册服务和 slot 组件，
  // 在 declareAppSlots 之后加载，确保所有 slot 已声明
  const uiProviders: Array<{ name: string; plugin: any }> = [
    { name: 'ui-goal', plugin: uiGoalProvider },
    { name: 'ui-jobs', plugin: uiJobsProvider },
    { name: 'ui-plan', plugin: uiPlanProvider },
    { name: 'ui-model-selection', plugin: uiModelSelectionProvider },
    { name: 'ui-permission-presets', plugin: uiPermissionPresetsProvider },
    { name: 'ui-trajectory', plugin: uiTrajectoryProvider },
    { name: 'ui-deliverables', plugin: uiDeliverablesProvider },
    { name: 'ui-subagent', plugin: uiSubagentProvider },
    { name: 'ui-user-questions', plugin: uiUserQuestionsProvider },
    { name: 'ui-workflow-run', plugin: uiWorkflowRunProvider },
    { name: 'ui-attachment', plugin: uiAttachmentProvider },
    { name: 'ui-workspace', plugin: uiWorkspaceProvider },
    { name: 'ui-settings-general', plugin: uiSettingsGeneralProvider },
    { name: 'ui-settings-models', plugin: uiSettingsModelsProvider },
    { name: 'ui-settings-plugin-inventory', plugin: uiSettingsPluginInventoryProvider },
    { name: 'ui-settings-plugins', plugin: uiSettingsPluginsProvider },
    { name: 'ui-slots', plugin: uiSlotsProvider },
    { name: 'ui-layout', plugin: uiLayoutProvider },
    { name: 'ui-directory-picker', plugin: uiDirectoryPickerProvider },
    { name: 'ui-message-feedback', plugin: uiMessageFeedbackProvider },
  ]

  for (const { name, plugin } of uiProviders) {
    try {
      ctx.plugin(plugin as any)
      console.log(`[UI Plugins] Loaded provider: ${name}`)
    } catch (err) {
      console.warn(`[UI Plugins] Failed to load provider ${name}:`, err)
    }
  }
}
