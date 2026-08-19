// @ts-nocheck
/**
 * Codem UI Slot 声明 — 定义所有 UI 槽位类型。
 *
 * UI 插件包通过 declaration merging 扩展 SlotMap，
 * 实现类型安全的槽位注册。
 */

import type { SlotMap, SlotEntryDef } from '../slots/index.ts'

// ========== 布局槽位 ==========
declare module '../slots/index.ts' {
  interface SlotMap {
    'app.layout': SlotEntryDef & { kind: 'single' }
    'app.sidebar': SlotEntryDef & { kind: 'single' }
    'app.conversation': SlotEntryDef & { kind: 'single' }
    'app.settings': SlotEntryDef & { kind: 'keyed'; keyProps: { tab: string } }
    'app.overlay': SlotEntryDef & { kind: 'list' }
    'app.market': SlotEntryDef & { kind: 'single' }
    'app.monitor': SlotEntryDef & { kind: 'single' }
    'app.goal': SlotEntryDef & { kind: 'single' }
    'app.plan': SlotEntryDef & { kind: 'single' }
    'app.jobs': SlotEntryDef & { kind: 'single' }
    'app.model-selection': SlotEntryDef & { kind: 'single' }
    'app.right-panel': SlotEntryDef & { kind: 'single' }
    'app.subagent': SlotEntryDef & { kind: 'single' }
    'app.user-questions': SlotEntryDef & { kind: 'single' }
    'app.workflow-run': SlotEntryDef & { kind: 'single' }
    'app.attachment': SlotEntryDef & { kind: 'single' }
    'app.workspace': SlotEntryDef & { kind: 'single' }
    'app.settings.general': SlotEntryDef & { kind: 'single' }
    'app.settings.models': SlotEntryDef & { kind: 'single' }
    'app.settings.plugins': SlotEntryDef & { kind: 'single' }
  }
}

// ========== 会话内部槽位 ==========
declare module '../slots/index.ts' {
  interface SlotMap {
    'conversation.input': SlotEntryDef & { kind: 'single' }
    'conversation.messages': SlotEntryDef & { kind: 'single' }
    'conversation.node.tool': SlotEntryDef & { kind: 'single' }
    'conversation.details.tool': SlotEntryDef & { kind: 'single' }
    'conversation.node.assistant': SlotEntryDef & { kind: 'chain' }
  }
}

// ========== Cordis 管理面板槽位 ==========
declare module '../slots/index.ts' {
  interface SlotMap {
    'app.cordis': SlotEntryDef & { kind: 'single' }
    'app.plugin-manager': SlotEntryDef & { kind: 'single' }
    'app.plugin-market': SlotEntryDef & { kind: 'single' }
  }
}
