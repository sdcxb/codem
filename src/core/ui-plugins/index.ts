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

/**
 * UI 插件聚合器 — 加载所有 UI 插件包。
 * 在 Cordis Context 启动后调用。
 */
export function loadUIPlugins(ctx: Context) {
  // 设置全局 Context
  const { setActiveContext } = require('../consumer/index.ts')
  setActiveContext(ctx)

  // 先声明所有 App 级别的 Slot
  declareAppSlots(ctx)

  // 按顺序加载 UI 插件
  const plugins = [
    { name: 'ui-theme', apply: themeApply },
    { name: 'ui-sidebar', apply: sidebarApply },
    { name: 'ui-conversation', apply: conversationApply },
    { name: 'ui-tool', apply: toolApply },
    { name: 'ui-settings', apply: settingsApply },
    { name: 'ui-misc', apply: miscApply },
    { name: 'ui-panels', apply: panelsApply },
    { name: 'ui-market', apply: marketApply },
    { name: 'ui-skin-default', apply: skinDefaultApply },
    { name: 'ui-skin-pet', apply: skinPetApply },
    { name: 'ui-pet', apply: uiPetApply },
  ]

  for (const { name, apply } of plugins) {
    try {
      apply()
      console.log(`[UI Plugins] Loaded: ${name}`)
    } catch (err) {
      console.warn(`[UI Plugins] Failed to load ${name}:`, err)
    }
  }
}
