// @ts-nocheck
/**
 * 框架级 Slot 声明 — 在 Cordis Context 初始化时声明所有 App 级别的 UI 槽位。
 *
 * 这些 slot 是 "well-known" 的，插件包可以直接注册组件到这些槽位。
 */
import type { Context } from '../cordis/src/index.ts'
import type { SlotSpec, SlotEntryDef } from '../slots/index.ts'

/** 声明所有 App 级别的 UI 槽位 */
export function declareAppSlots(ctx: Context): void {
  const slots = ctx.slots

  // ===== 布局槽位 =====
  slots.declareSlot('app.titlebar', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.boot-splash', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.workspace-backdrop', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.toast-container', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 主布局 =====
  slots.declareSlot('app.sidebar', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.conversation', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.terminal', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.file-explorer', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.file-editor', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.right-sidebar', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.layout', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 模态对话框/面板 =====
  slots.declareSlot('app.settings', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.project-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.config-editor', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.bootstrap-wizard', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.permission-dialog', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.decision-tray', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.confirm-dialog', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.close-confirm-dialog', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.needs-you-panel', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.search-dialog', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 管理器面板 =====
  slots.declareSlot('app.mcp-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.skill-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.memory-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.session-recovery', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.usage-stats', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.task-center', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.agent-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.notebook-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.notebook-workspace', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.source-viewer', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.github-clone-dialog', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.cicd-panel', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.performance-dashboard', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.diff-viewer', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.inline-diff-review', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.interactive-form-dialog', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.prompt-change-review-dialog', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.plan-approval-card', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 扩展面板 =====
  slots.declareSlot('app.onboarding-tour', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.quick-access-cards', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.correction-result-panel', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.clarification-form', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.pipeline-next-step-dialog', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 叠加层（list 类型，可多个插件同时贡献） =====
  slots.declareSlot('app.overlay', { kind: 'list', scope: 'root' }, 'framework')

  // ===== 皮肤槽位 =====
  slots.declareSlot('app.skin-layout', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 会话内部子槽位 =====
  slots.declareSlot('conversation.input', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('conversation.messages', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('conversation.node.tool', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('conversation.details.tool', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('conversation.node.assistant', { kind: 'chain', scope: 'root' }, 'framework')

  // ===== Cordis 管理面板 =====
  slots.declareSlot('app.cordis', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.plugin-manager', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.plugin-market', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 能力监控面板 =====
  slots.declareSlot('app.monitor', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.goal', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.plan', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.jobs', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.model-selection', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.message-feedback', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.tool', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.deliverables', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.trajectory', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.workspace', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.permission-presets', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.ui-commands', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 设置面板的 tab 槽位（keyed） =====
  slots.declareSlot('app.settings.general', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.settings.models', { kind: 'single', scope: 'root' }, 'framework')
  slots.declareSlot('app.settings.plugins', { kind: 'single', scope: 'root' }, 'framework')

  // ===== 侧边栏 tab 槽位（list 类型） =====
  slots.declareSlot('sidebar.tabs', { kind: 'list', scope: 'root' }, 'framework')
  slots.declareSlot('sidebar.bottom-tabs', { kind: 'list', scope: 'root' }, 'framework')

  // ===== 底部面板 tab 槽位（list 类型） =====
  slots.declareSlot('bottom-panel.tabs', { kind: 'list', scope: 'root' }, 'framework')
}
