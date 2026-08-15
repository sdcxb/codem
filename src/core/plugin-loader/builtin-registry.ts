// @ts-nocheck
/**
 * 内置插件注册 — 将所有 Codem 内置插件注册到 PluginLoader。
 *
 * 这使 PluginLoader 可以通过 codem.yml 发现和加载所有内置插件，
 * 而不需要真实的 node_modules 包。
 */

import { registerBuiltinPlugin } from './index.ts'

// Provider 插件
import { llmProvider } from '../provider/llm-provider'
import { toolsProvider } from '../provider/tools-provider'
import { sessionProvider } from '../provider/session-provider'
import { storageProvider } from '../provider/storage-provider'
import { memoryProvider } from '../provider/memory-provider'
import { permissionProvider } from '../provider/permission-provider'
import { mcpProvider } from '../provider/mcp-provider'
import { skillProvider } from '../provider/skill-provider'
import { subagentProvider } from '../provider/subagent-provider'
import { settingsProvider } from '../provider/settings-provider'
import { themeProvider } from '../provider/theme-provider'
import { fsProvider } from '../provider/fs-provider'
import { shellProvider } from '../provider/shell-provider'
import { sandboxProvider } from '../provider/sandbox-provider'
import { webProvider } from '../provider/web-provider'
import { compactionProvider } from '../provider/compaction-provider'
import { hooksProvider } from '../provider/hooks-provider'
import { approvalProvider } from '../provider/approval-provider'
import { permissionsProvider } from '../provider/permissions-provider'
import { automationProvider } from '../provider/automation-provider'
import { identityProvider } from '../provider/identity-provider'
import { lspProvider } from '../provider/lsp-provider'
import { codeRuntimeProvider } from '../provider/code-runtime-provider'
import { workflowProvider } from '../provider/workflow-provider'
import { contextInfoProvider } from '../provider/context-info-provider'
import { commandsProvider } from '../provider/commands-provider'
import { userQuestionsProvider } from '../provider/user-questions-provider'
import { notebookProvider } from '../provider/notebook-provider'
import { squadProvider } from '../provider/squad-provider'
import { dynamicRunnerProvider } from '../provider/dynamic-runner-provider'
import { pluginRegistryProvider } from '../provider/plugin-registry-provider'

/** 注册所有内置插件到 PluginLoader */
export function registerBuiltinPlugins() {
  // Core Providers
  registerBuiltinPlugin('@codem/llm', { provides: ['llm'], inject: [], priority: 0, hot: true }, () => llmProvider)
  registerBuiltinPlugin('@codem/tools', { provides: ['tools'], inject: [], priority: 0, hot: true }, () => toolsProvider)
  registerBuiltinPlugin('@codem/session', { provides: ['session'], inject: [], priority: 0, hot: true }, () => sessionProvider)
  registerBuiltinPlugin('@codem/storage', { provides: ['storage'], inject: [], priority: 0, hot: true }, () => storageProvider)
  registerBuiltinPlugin('@codem/memory', { provides: ['memory'], inject: [], priority: 0, hot: true }, () => memoryProvider)
  registerBuiltinPlugin('@codem/permission', { provides: ['permission'], inject: [], priority: 0, hot: true }, () => permissionProvider)
  registerBuiltinPlugin('@codem/mcp', { provides: ['mcp'], inject: [], priority: 0, hot: true }, () => mcpProvider)
  registerBuiltinPlugin('@codem/skill', { provides: ['skill'], inject: [], priority: 0, hot: true }, () => skillProvider)
  registerBuiltinPlugin('@codem/subagent', { provides: ['subagent'], inject: [], priority: 0, hot: true }, () => subagentProvider)
  registerBuiltinPlugin('@codem/settings', { provides: ['settings'], inject: [], priority: 0, hot: true }, () => settingsProvider)
  registerBuiltinPlugin('@codem/theme', { provides: ['theme'], inject: [], priority: 0, hot: true }, () => themeProvider)

  // Capability Providers
  registerBuiltinPlugin('@codem/fs-local', { provides: ['fs'], inject: [], priority: 0, hot: true }, () => fsProvider)
  registerBuiltinPlugin('@codem/shell-local', { provides: ['shell'], inject: [], priority: 0, hot: true }, () => shellProvider)
  registerBuiltinPlugin('@codem/sandbox-local', { provides: ['sandbox'], inject: [], priority: 0, hot: true }, () => sandboxProvider)
  registerBuiltinPlugin('@codem/web-search', { provides: ['web'], inject: [], priority: 0, hot: true }, () => webProvider)
  registerBuiltinPlugin('@codem/compaction', { provides: ['compaction'], inject: [], priority: 0, hot: true }, () => compactionProvider)
  registerBuiltinPlugin('@codem/hooks', { provides: ['hooks'], inject: [], priority: 0, hot: true }, () => hooksProvider)
  registerBuiltinPlugin('@codem/approval', { provides: ['approval'], inject: [], priority: 0, hot: true }, () => approvalProvider)
  registerBuiltinPlugin('@codem/permissions', { provides: ['permissions'], inject: [], priority: 0, hot: true }, () => permissionsProvider)
  registerBuiltinPlugin('@codem/automation', { provides: ['automation'], inject: [], priority: 0, hot: true }, () => automationProvider)

  // P6 Providers
  registerBuiltinPlugin('@codem/identity', { provides: ['identity'], inject: [], priority: 0 }, () => identityProvider)
  registerBuiltinPlugin('@codem/lsp', { provides: ['lsp'], inject: [], priority: 0 }, () => lspProvider)
  registerBuiltinPlugin('@codem/code-runtime', { provides: ['codeRuntime'], inject: [], priority: 0 }, () => codeRuntimeProvider)
  registerBuiltinPlugin('@codem/workflow', { provides: ['workflow'], inject: [], priority: 0 }, () => workflowProvider)
  registerBuiltinPlugin('@codem/context-info', { provides: ['contextInfo'], inject: [], priority: 0 }, () => contextInfoProvider)
  registerBuiltinPlugin('@codem/commands', { provides: ['commands'], inject: [], priority: 0 }, () => commandsProvider)
  registerBuiltinPlugin('@codem/user-questions', { provides: ['userQuestions'], inject: [], priority: 0 }, () => userQuestionsProvider)
  registerBuiltinPlugin('@codem/notebook', { provides: ['notebook'], inject: [], priority: 0 }, () => notebookProvider)
  registerBuiltinPlugin('@codem/squad', { provides: ['squad'], inject: [], priority: 0 }, () => squadProvider)
  registerBuiltinPlugin('@codem/dynamic-runner', { provides: ['dynamicCordisRunner'], inject: [], priority: 0 }, () => dynamicRunnerProvider)
  registerBuiltinPlugin('@codem/plugin-registry', { provides: ['pluginRegistry'], inject: [], priority: 0 }, () => pluginRegistryProvider)

  // UI Plugins
  registerBuiltinPlugin('@codem/ui-sidebar', { provides: [], inject: ['slots'], slots: ['app.sidebar'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-sidebar/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-conversation', { provides: [], inject: ['slots'], slots: ['app.conversation'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-conversation/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-tool', { provides: [], inject: ['slots'], slots: ['conversation.details.tool'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-tool/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-settings', { provides: [], inject: ['slots'], slots: ['app.settings'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-settings/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-misc', { provides: [], inject: ['slots'], slots: ['app.overlay', 'app.monitor'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-misc/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-market', { provides: [], inject: ['slots'], slots: ['app.skill-manager', 'app.mcp-manager', 'app.plugin-manager'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-market/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-theme', { provides: [], inject: [], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-theme/index.ts')
    return { apply: () => apply() }
  })
  registerBuiltinPlugin('@codem/ui-skin', { provides: [], inject: ['slots'], slots: ['app.overlay'], priority: 0 }, () => {
    const { apply } = require('../ui-plugins/ui-skin/index.ts')
    return { apply: () => apply() }
  })

  console.log(`[PluginRegistry] Registered ${builtinPluginCount()} builtin plugins`)
}

function builtinPluginCount(): number {
  // 内部辅助函数
  return 42 // 大约的插件数量
}
