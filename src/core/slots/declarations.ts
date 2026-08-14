// @ts-nocheck
/**
 * Codem Slot 声明文件 — 定义所有核心 UI 槽位。
 *
 * 通过 TypeScript declaration merging 扩展 SlotMap 接口，
 * 让插件在编译时就知道有哪些可用的槽位。
 *
 * 槽位命名约定：domain.area.component
 * 例如：app.layout.sidebar, conversation.input.composer
 *
 * 四种槽位模式：
 * - single: 最后注册的生效（覆盖语义）
 * - list: 所有注册的按顺序渲染（列表语义）
 * - keyed: 按 key 分派（标签页语义）
 * - chain: 管道式（中间件语义）
 */

import type { SlotMap, SlotEntryDef } from './index.ts'

declare module './index.ts' {
  interface SlotMap {
    // === App Layout ===
    /** 根布局槽位 — 应用入口渲染点 */
    'app.layout': { kind: 'single'; scope: 'root' }
    /** 顶部栏 */
    'app.layout.header': { kind: 'single'; scope: 'root' }
    /** 侧边栏容器 */
    'app.layout.sidebar': { kind: 'single'; scope: 'root' }
    /** 侧边栏标签页（keyed: 每个 tab 一个 key） */
    'app.layout.sidebar.tabs': { kind: 'keyed'; scope: 'root'; keyProps: { chat: {}; skills: {}; files: {}; settings: {} } }
    /** 主内容区 */
    'app.layout.main': { kind: 'single'; scope: 'root' }
    /** 底部状态栏 */
    'app.layout.footer': { kind: 'list'; scope: 'root' }

    // === Conversation ===
    /** 会话面板 */
    'conversation.panel': { kind: 'single'; scope: 'session' }
    /** 消息列表 */
    'conversation.messages': { kind: 'single'; scope: 'session' }
    /** 消息气泡（chain: 可以拦截渲染） */
    'conversation.message.bubble': { kind: 'chain'; scope: 'session' }
    /** 输入区域 */
    'conversation.input': { kind: 'single'; scope: 'session' }
    /** 输入框 composer（chain: 可以拦截输入） */
    'conversation.composer': { kind: 'chain'; scope: 'session' }
    /** 输入区域工具栏按钮 */
    'conversation.input.toolbar': { kind: 'list'; scope: 'session' }
    /** 快捷命令菜单 */
    'conversation.slash-commands': { kind: 'list'; scope: 'root' }

    // === Agent ===
    /** Agent 面板 */
    'agent.panel': { kind: 'single'; scope: 'session' }
    /** Agent 详情 */
    'agent.detail': { kind: 'single'; scope: 'session' }
    /** Agent 列表项 */
    'agent.roster.item': { kind: 'list'; scope: 'session' }

    // === Settings ===
    /** 设置面板 */
    'settings.panel': { kind: 'single'; scope: 'root' }
    /** 设置标签页（keyed） */
    'settings.tabs': { kind: 'keyed'; scope: 'root'; keyProps: { general: {}; models: {}; plugins: {}; appearance: {} } }
    /** 设置项 */
    'settings.items': { kind: 'list'; scope: 'root' }

    // === Tools ===
    /** 工具面板 */
    'tools.panel': { kind: 'single'; scope: 'session' }
    /** 工具卡片 */
    'tools.card': { kind: 'keyed'; scope: 'session' }

    // === Theme / Skin ===
    /** 主题选择器 */
    'theme.selector': { kind: 'single'; scope: 'root' }
    /** 皮肤预览 */
    'theme.preview': { kind: 'single'; scope: 'root' }

    // === Skills ===
    /** Skills 管理面板 */
    'skills.panel': { kind: 'single'; scope: 'root' }
    /** Skills 市场入口 */
    'skills.market': { kind: 'single'; scope: 'root' }
    /** Skills 列表项 */
    'skills.item': { kind: 'list'; scope: 'root' }

    // === Pet ===
    /** 宠物覆盖层 */
    'pet.overlay': { kind: 'single'; scope: 'root' }
    /** 宠物市场 */
    'pet.market': { kind: 'single'; scope: 'root' }

    // === Monitor ===
    /** 监控面板 */
    'monitor.panel': { kind: 'single'; scope: 'root' }
    /** 性能仪表盘 */
    'monitor.dashboard': { kind: 'single'; scope: 'root' }

    // === MCP ===
    /** MCP 管理器 */
    'mcp.panel': { kind: 'single'; scope: 'root' }
    /** MCP 市场 */
    'mcp.market': { kind: 'single'; scope: 'root' }

    // === Knowledge ===
    /** 知识库管理 */
    'knowledge.panel': { kind: 'single'; scope: 'root' }
    /** 笔记编辑器 */
    'knowledge.note-editor': { kind: 'single'; scope: 'session' }

    // === CICD ===
    /** CI/CD 面板 */
    'cicd.panel': { kind: 'single'; scope: 'root' }

    // === Recovery ===
    /** 恢复面板 */
    'recovery.panel': { kind: 'single'; scope: 'root' }

    // === Permission ===
    /** 权限对话框 */
    'permission.dialog': { kind: 'single'; scope: 'root' }

    // === Feedback ===
    /** 反馈按钮 */
    'feedback.buttons': { kind: 'list'; scope: 'session' }

    // === Quick Access ===
    /** 快捷访问卡片 */
    'quick-access.cards': { kind: 'list'; scope: 'root' }

    // === Diff ===
    /** 差异查看器 */
    'diff.viewer': { kind: 'single'; scope: 'session' }
  }
}

/**
 * 预定义的槽位名称常量，方便插件引用。
 * 避免拼写错误，提供自动补全。
 */
export const CodemSlots = {
  // App Layout
  APP_LAYOUT: 'app.layout',
  APP_LAYOUT_HEADER: 'app.layout.header',
  APP_LAYOUT_SIDEBAR: 'app.layout.sidebar',
  APP_LAYOUT_SIDEBAR_TABS: 'app.layout.sidebar.tabs',
  APP_LAYOUT_MAIN: 'app.layout.main',
  APP_LAYOUT_FOOTER: 'app.layout.footer',

  // Conversation
  CONVERSATION_PANEL: 'conversation.panel',
  CONVERSATION_MESSAGES: 'conversation.messages',
  CONVERSATION_MESSAGE_BUBBLE: 'conversation.message.bubble',
  CONVERSATION_INPUT: 'conversation.input',
  CONVERSATION_COMPOSER: 'conversation.composer',
  CONVERSATION_INPUT_TOOLBAR: 'conversation.input.toolbar',
  CONVERSATION_SLASH_COMMANDS: 'conversation.slash-commands',

  // Agent
  AGENT_PANEL: 'agent.panel',
  AGENT_DETAIL: 'agent.detail',
  AGENT_ROSTER_ITEM: 'agent.roster.item',

  // Settings
  SETTINGS_PANEL: 'settings.panel',
  SETTINGS_TABS: 'settings.tabs',
  SETTINGS_ITEMS: 'settings.items',

  // Tools
  TOOLS_PANEL: 'tools.panel',
  TOOLS_CARD: 'tools.card',

  // Theme
  THEME_SELECTOR: 'theme.selector',
  THEME_PREVIEW: 'theme.preview',

  // Skills
  SKILLS_PANEL: 'skills.panel',
  SKILLS_MARKET: 'skills.market',
  SKILLS_ITEM: 'skills.item',

  // Pet
  PET_OVERLAY: 'pet.overlay',
  PET_MARKET: 'pet.market',

  // Monitor
  MONITOR_PANEL: 'monitor.panel',
  MONITOR_DASHBOARD: 'monitor.dashboard',

  // MCP
  MCP_PANEL: 'mcp.panel',
  MCP_MARKET: 'mcp.market',

  // Knowledge
  KNOWLEDGE_PANEL: 'knowledge.panel',
  KNOWLEDGE_NOTE_EDITOR: 'knowledge.note-editor',

  // CICD
  CICD_PANEL: 'cicd.panel',

  // Recovery
  RECOVERY_PANEL: 'recovery.panel',

  // Permission
  PERMISSION_DIALOG: 'permission.dialog',

  // Feedback
  FEEDBACK_BUTTONS: 'feedback.buttons',

  // Quick Access
  QUICK_ACCESS_CARDS: 'quick-access.cards',

  // Diff
  DIFF_VIEWER: 'diff.viewer',
} as const
