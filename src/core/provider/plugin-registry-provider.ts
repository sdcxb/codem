// @ts-nocheck
/**
 * Plugin Registry Provider 插件 — 插件注册表和搜索服务，可独立加载/卸载/热替换。
 *
 * 提供完整的插件元数据（包含 provides/inject 依赖关系、tags 类型标签、
 * core/locked 核心保护标记、riskLevel 风险等级），供 PluginManager 使用。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const pluginRegistryProvider: Plugin = (ctx: any) => {
  const pluginMeta = new Map<string, any>()

  const knownPlugins = [
    // ===== 核心系统插件（不可关闭） =====
    { name: '@codem/slots', version: '1.0.0', description: 'Slot Registry — UI 插件槽位注册系统，所有 UI 插件的基础设施', provides: ['slots'], inject: [], keywords: ['slots', 'registry', 'ui'], category: 'core', tags: ['infra', 'ui'], core: true, locked: true, icon: '🧩', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭将导致所有 UI 插件失效，界面无法正常渲染' },

    // ===== Core Service Providers（核心服务） =====
    { name: '@codem/llm', version: '1.0.0', description: 'LLM Service — 大语言模型调用服务，Agent 的核心推理能力', provides: ['llm'], inject: [], keywords: ['llm', 'ai'], category: 'provider', tags: ['service', 'agent'], hot: true, icon: '🤖', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后 Agent 将无法进行推理和生成回复，所有对话功能不可用' },
    { name: '@codem/tools', version: '1.0.0', description: 'Tools Service — 工具注册和调用服务，Agent 执行操作的能力', provides: ['tools'], inject: [], keywords: ['tools'], category: 'provider', tags: ['service', 'tool'], hot: true, icon: '🔧', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后 Agent 将无法调用任何工具（文件读写、命令执行等）' },
    { name: '@codem/session', version: '1.0.0', description: 'Session Service — 会话管理服务，维护对话上下文和状态', provides: ['session'], inject: [], keywords: ['session'], category: 'provider', tags: ['service', 'storage'], hot: true, icon: '💬', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后无法创建或恢复会话，对话历史将丢失' },
    { name: '@codem/storage', version: '1.0.0', description: 'Storage Service — 持久化存储服务，配置和数据的保存', provides: ['storage'], inject: [], keywords: ['storage'], category: 'provider', tags: ['service', 'storage'], hot: true, icon: '💾', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后所有设置和数据无法持久化，重启后恢复默认' },
    { name: '@codem/memory', version: '1.0.0', description: 'Memory Service — 记忆管理服务，跨会话的知识保留', provides: ['memory'], inject: [], keywords: ['memory'], category: 'provider', tags: ['service', 'storage'], hot: true, icon: '🧠', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后 Agent 将无法记忆跨会话信息，每次对话从零开始' },
    { name: '@codem/permission', version: '1.0.0', description: 'Permission Service — 权限控制服务，工具调用的安全审批', provides: ['permission'], inject: [], keywords: ['permission'], category: 'provider', tags: ['service', 'security'], hot: true, icon: '🔐', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后工具调用将跳过权限检查，存在安全风险' },
    { name: '@codem/mcp', version: '1.0.0', description: 'MCP Service — Model Context Protocol 工具协议服务', provides: ['mcp'], inject: [], keywords: ['mcp'], category: 'provider', tags: ['service', 'tool', 'bridge'], hot: true, icon: '🔌', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后无法使用 MCP 协议的第三方工具' },
    { name: '@codem/skill', version: '1.0.0', description: 'Skill Service — 技能注册服务，Agent 的技能库', provides: ['skill'], inject: [], keywords: ['skill'], category: 'provider', tags: ['service', 'agent'], hot: true, icon: '⚡', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后 Agent 将无法使用技能（预定义的提示词模板）' },
    { name: '@codem/subagent', version: '1.0.0', description: 'Subagent Service — 子代理管理服务，多 Agent 编排', provides: ['subagent'], inject: [], keywords: ['subagent'], category: 'provider', tags: ['service', 'agent'], hot: true, icon: '👥', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后无法创建子 Agent，多智能体协同功能不可用' },
    { name: '@codem/settings', version: '1.0.0', description: 'Settings Service — 设置管理服务，全局配置', provides: ['settings'], inject: [], keywords: ['settings'], category: 'provider', tags: ['service'], hot: true, icon: '⚙️', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后无法读取或保存应用设置' },
    { name: '@codem/theme', version: '1.0.0', description: 'Theme Service — 主题管理服务，UI 外观切换', provides: ['theme'], inject: [], keywords: ['theme'], category: 'provider', tags: ['service', 'ui'], hot: true, icon: '🎨', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后主题切换不可用，界面恢复默认样式' },

    // ===== Capability Providers（能力实现） =====
    { name: '@codem/fs-local', version: '1.0.0', description: 'Local FileSystem Provider — 本地文件系统读写', provides: ['fs'], inject: [], keywords: ['fs', 'file'], category: 'provider', tags: ['provider', 'storage'], hot: true, icon: '📁', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后 Agent 无法读写文件，文件相关工具全部失效' },
    { name: '@codem/shell-local', version: '1.0.0', description: 'Local Shell Provider — 本地命令行执行', provides: ['shell'], inject: [], keywords: ['shell'], category: 'provider', tags: ['provider', 'runtime'], hot: true, icon: '🖥️', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后 Agent 无法执行命令行操作（编译、安装、运行等）' },
    { name: '@codem/sandbox-local', version: '1.0.0', description: 'Sandbox Provider — 沙箱隔离执行环境', provides: ['sandbox'], inject: [], keywords: ['sandbox'], category: 'provider', tags: ['provider', 'security'], hot: true, icon: '📦', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后沙箱执行环境不可用，代码运行将在直接本地执行' },
    { name: '@codem/web-search', version: '1.0.0', description: 'Web Search Provider — 网页搜索服务', provides: ['web'], inject: [], keywords: ['web', 'search'], category: 'provider', tags: ['provider'], hot: true, icon: '🔍', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后 Agent 无法进行网页搜索' },
    { name: '@codem/compaction', version: '1.0.0', description: 'Compaction Provider — 上下文压缩服务，自动裁剪长对话', provides: ['compaction'], inject: [], keywords: ['compaction'], category: 'provider', tags: ['provider'], hot: true, icon: '✂️', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后长对话无法自动压缩，可能导致 token 溢出' },
    { name: '@codem/hooks', version: '1.0.0', description: 'Hooks Provider — 钩子事件服务，生命周期回调', provides: ['hooks'], inject: [], keywords: ['hooks'], category: 'provider', tags: ['provider'], hot: true, icon: '🪝', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后生命周期钩子不可用' },
    { name: '@codem/approval', version: '1.0.0', description: 'Approval Provider — 审批服务，关键操作的人工确认', provides: ['approval'], inject: [], keywords: ['approval'], category: 'provider', tags: ['provider', 'security'], hot: true, icon: '✅', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后关键操作将跳过人工审批，存在安全风险' },
    { name: '@codem/permissions', version: '1.0.0', description: 'Permissions Provider — 权限策略服务，细粒度访问控制', provides: ['permissions'], inject: [], keywords: ['permissions'], category: 'provider', tags: ['provider', 'security'], hot: true, icon: '🛡️', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后细粒度权限策略不可用' },
    { name: '@codem/automation', version: '1.0.0', description: 'Automation Provider — 自动化执行服务', provides: ['automation'], inject: [], keywords: ['automation'], category: 'provider', tags: ['provider'], hot: true, icon: '🤖', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后自动化任务触发器不可用' },

    // ===== P6 Providers（扩展能力） =====
    { name: '@codem/identity', version: '1.0.0', description: 'Identity Provider — 身份认证服务', provides: ['identity'], inject: [], keywords: ['identity'], category: 'provider', tags: ['provider', 'security'], icon: '🪪', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后身份认证不可用' },
    { name: '@codem/lsp', version: '1.0.0', description: 'LSP Provider — 语言服务器协议，代码智能提示', provides: ['lsp'], inject: [], keywords: ['lsp'], category: 'provider', tags: ['provider', 'tool'], icon: '📄', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后代码补全和诊断不可用' },
    { name: '@codem/code-runtime', version: '1.0.0', description: 'Code Runtime Provider — 代码运行时，执行代码片段', provides: ['codeRuntime'], inject: [], keywords: ['code', 'runtime'], category: 'provider', tags: ['provider', 'runtime'], icon: '🏃', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后代码片段直接运行功能不可用' },
    { name: '@codem/workflow', version: '1.0.0', description: 'Workflow Provider — 工作流引擎，多步骤任务编排', provides: ['workflow'], inject: [], keywords: ['workflow'], category: 'provider', tags: ['provider', 'agent'], icon: '🔄', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后工作流编排功能不可用' },
    { name: '@codem/context-info', version: '1.0.0', description: 'Context Info Provider — 上下文信息收集', provides: ['contextInfo'], inject: [], keywords: ['context'], category: 'provider', tags: ['provider'], icon: '📋', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后上下文信息收集不可用' },
    { name: '@codem/commands', version: '1.0.0', description: 'Commands Provider — 命令注册服务，快捷操作', provides: ['commands'], inject: [], keywords: ['commands'], category: 'provider', tags: ['provider', 'tool'], icon: '⌘', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后自定义命令快捷操作不可用' },
    { name: '@codem/user-questions', version: '1.0.0', description: 'User Questions Provider — 用户提问服务，Agent 主动询问', provides: ['userQuestions'], inject: [], keywords: ['questions'], category: 'provider', tags: ['provider', 'agent'], icon: '❓', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后 Agent 无法主动向用户提问，交互体验降级' },
    { name: '@codem/notebook', version: '1.0.0', description: 'Notebook Provider — 笔记本服务，知识管理', provides: ['notebook'], inject: [], keywords: ['notebook'], category: 'provider', tags: ['provider', 'storage'], icon: '📓', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后笔记本功能不可用' },
    { name: '@codem/squad', version: '1.0.0', description: 'Squad Provider — 多智能体编排，Agent 团队协作', provides: ['squad'], inject: [], keywords: ['squad'], category: 'provider', tags: ['provider', 'agent'], icon: '🎯', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后多智能体团队协作功能不可用' },
    { name: '@codem/dynamic-runner', version: '1.0.0', description: 'Dynamic Runner Provider — 动态运行器，运行时代码执行', provides: ['dynamicCordisRunner'], inject: [], keywords: ['runner'], category: 'provider', tags: ['provider', 'runtime'], icon: '⚡', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后动态运行器不可用' },
    { name: '@codem/plugin-registry', version: '1.0.0', description: 'Plugin Registry Provider — 插件注册表服务，插件市场的数据源', provides: ['pluginRegistry'], inject: [], keywords: ['registry'], category: 'core', tags: ['infra', 'service'], icon: '📜', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后插件市场将无法显示插件列表和搜索' },

    // ===== dsh 兼容层 =====
    { name: '@codem/dsh-compat', version: '1.0.0', description: 'DeepSeek Harness Compatibility Layer — dsh 插件兼容适配层，使 dsh 插件可在 Codem 中运行', provides: ['dshLLM', 'dshShell', 'dshFS', 'dshTools'], inject: ['llm', 'shell', 'fs', 'tools'], keywords: ['dsh', 'compat'], category: 'compat', tags: ['bridge'], icon: '🔗', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后 dsh (DeepSeek Harness) 插件将无法运行' },

    // ===== UI 插件 =====
    { name: '@codem/ui-sidebar', version: '1.0.0', description: 'Sidebar UI Plugin — 侧边栏界面，导航和项目管理', provides: [], inject: ['slots'], slots: ['app.sidebar'], keywords: ['ui', 'sidebar'], category: 'ui', tags: ['ui'], icon: '📋', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后侧边栏消失，无法导航到项目、设置等' },
    { name: '@codem/ui-conversation', version: '1.0.0', description: 'Conversation UI Plugin — 对话面板，Agent 交互主界面', provides: [], inject: ['slots'], slots: ['app.conversation'], keywords: ['ui', 'conversation'], category: 'ui', tags: ['ui'], icon: '💬', author: 'Codem Team', riskLevel: 'danger', riskDescription: '关闭后对话面板消失，无法与 Agent 交互' },
    { name: '@codem/ui-tool', version: '1.0.0', description: 'Tool UI Plugin — 工具调用详情面板', provides: [], inject: ['slots'], slots: ['conversation.details.tool'], keywords: ['ui', 'tool'], category: 'ui', tags: ['ui', 'tool'], icon: '🔨', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后工具调用详情不显示，但不影响工具执行' },
    { name: '@codem/ui-settings', version: '1.0.0', description: 'Settings UI Plugin — 设置面板，全局配置界面', provides: [], inject: ['slots'], slots: ['app.settings'], keywords: ['ui', 'settings'], category: 'ui', tags: ['ui'], icon: '⚙️', author: 'Codem Team', riskLevel: 'caution', riskDescription: '关闭后设置面板不可用，无法修改配置' },
    { name: '@codem/ui-misc', version: '1.0.0', description: 'Misc UI Plugin — 杂项 UI 组件（Monitor、Overlay 等）', provides: [], inject: ['slots'], slots: ['app.overlay', 'app.monitor'], keywords: ['ui', 'misc'], category: 'ui', tags: ['ui'], icon: '🧪', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后部分辅助 UI 组件不显示' },
    { name: '@codem/ui-market', version: '1.0.0', description: 'Market UI Plugin — 插件市场 UI（Skill/MCP/Plugin 管理器）', provides: [], inject: ['slots'], slots: ['app.skill-manager', 'app.mcp-manager', 'app.plugin-manager'], keywords: ['ui', 'market'], category: 'ui', tags: ['ui'], icon: '🏪', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后插件市场、技能管理、MCP 管理界面不可用' },
    { name: '@codem/ui-theme', version: '1.0.0', description: 'Theme UI Plugin — 主题插件，暗色/亮色切换', provides: [], inject: [], keywords: ['theme'], category: 'ui', tags: ['ui'], icon: '🎨', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后主题切换 UI 不可用' },
    { name: '@codem/ui-skin', version: '1.0.0', description: 'Skin UI Plugin — 皮肤插件，自定义外观', provides: [], inject: ['slots'], slots: ['app.overlay'], keywords: ['skin'], category: 'ui', tags: ['ui'], icon: '🎭', author: 'Codem Team', riskLevel: 'safe', riskDescription: '关闭后自定义皮肤不可用' },
  ]
  for (const p of knownPlugins) { pluginMeta.set(p.name, p) }

  const dispose = ctx.provide('pluginRegistry', {
    register(meta: any) { pluginMeta.set(meta.name, meta) },
    unregister(name: string) { pluginMeta.delete(name) },
    get(name: string) { return pluginMeta.get(name) },
    search(query: string, limit: number = 20) {
      const q = query.toLowerCase()
      return [...pluginMeta.values()].filter(p =>
        p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) ||
        p.keywords?.some((k: string) => k.toLowerCase().includes(q))
      ).slice(0, limit)
    },
    list() { return [...pluginMeta.values()] },
    listByCapability(cap: string) { return [...pluginMeta.values()].filter(p => p.provides?.includes(cap) || p.inject?.includes(cap)) },
  })

  return dispose
}
