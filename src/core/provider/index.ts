// @ts-nocheck
/**
 * Provider 插件包入口 — 导出所有独立 Provider 插件。
 *
 * 每个 Provider 是一个独立的 Cordis Plugin，可以单独加载/卸载/热替换。
 * bridge-plugin.ts 中的实现被拆分到这些独立 Provider 中。
 *
 * 加载策略：
 * - App.tsx 可以选择加载全部或部分 Provider
 * - 第三方插件可以注册更高优先级的 Provider 来替换默认实现
 * - Provider 可以在运行时被卸载和替换
 */

import type { Context, Plugin } from '../cordis/src/index.ts'

// 导入所有独立 Provider
export { llmProvider } from './llm-provider'
export { toolsProvider } from './tools-provider'
export { sessionProvider } from './session-provider'
export { storageProvider } from './storage-provider'
export { memoryProvider } from './memory-provider'
export { permissionProvider } from './permission-provider'
export { mcpProvider } from './mcp-provider'
export { skillProvider } from './skill-provider'
export { subagentProvider } from './subagent-provider'
export { settingsProvider } from './settings-provider'
export { themeProvider } from './theme-provider'
export { fsProvider } from './fs-provider'
export { shellProvider } from './shell-provider'
export { sandboxProvider } from './sandbox-provider'
export { webProvider } from './web-provider'
export { compactionProvider } from './compaction-provider'
export { hooksProvider } from './hooks-provider'
export { approvalProvider } from './approval-provider'
export { permissionsProvider } from './permissions-provider'
export { automationProvider } from './automation-provider'
export { identityProvider } from './identity-provider'
export { lspProvider } from './lsp-provider'
export { codeRuntimeProvider } from './code-runtime-provider'
export { workflowProvider } from './workflow-provider'
export { contextInfoProvider } from './context-info-provider'
export { commandsProvider } from './commands-provider'
export { userQuestionsProvider } from './user-questions-provider'
export { notebookProvider } from './notebook-provider'
export { squadProvider } from './squad-provider'
export { dynamicRunnerProvider } from './dynamic-runner-provider'
export { pluginRegistryProvider } from './plugin-registry-provider'

/**
 * 加载所有默认 Provider。
 * 在 App.tsx 的 getCordisContext() 中调用。
 */
export function loadDefaultProviders(ctx: Context): string[] {
  const loaded: string[] = []
  const providers: Array<{ name: string; plugin: Plugin }> = [
    { name: 'llm', plugin: llmProvider },
    { name: 'tools', plugin: toolsProvider },
    { name: 'session', plugin: sessionProvider },
    { name: 'storage', plugin: storageProvider },
    { name: 'memory', plugin: memoryProvider },
    { name: 'permission', plugin: permissionProvider },
    { name: 'mcp', plugin: mcpProvider },
    { name: 'skill', plugin: skillProvider },
    { name: 'subagent', plugin: subagentProvider },
    { name: 'settings', plugin: settingsProvider },
    { name: 'theme', plugin: themeProvider },
    { name: 'fs', plugin: fsProvider },
    { name: 'shell', plugin: shellProvider },
    { name: 'sandbox', plugin: sandboxProvider },
    { name: 'web', plugin: webProvider },
    { name: 'compaction', plugin: compactionProvider },
    { name: 'hooks', plugin: hooksProvider },
    { name: 'approval', plugin: approvalProvider },
    { name: 'permissions', plugin: permissionsProvider },
    { name: 'automation', plugin: automationProvider },
    { name: 'identity', plugin: identityProvider },
    { name: 'lsp', plugin: lspProvider },
    { name: 'codeRuntime', plugin: codeRuntimeProvider },
    { name: 'workflow', plugin: workflowProvider },
    { name: 'contextInfo', plugin: contextInfoProvider },
    { name: 'commands', plugin: commandsProvider },
    { name: 'userQuestions', plugin: userQuestionsProvider },
    { name: 'notebook', plugin: notebookProvider },
    { name: 'squad', plugin: squadProvider },
    { name: 'dynamicRunner', plugin: dynamicRunnerProvider },
    { name: 'pluginRegistry', plugin: pluginRegistryProvider },
  ]

  for (const { name, plugin } of providers) {
    try {
      ctx.plugin(plugin as any)
      loaded.push(name)
    } catch (err) {
      console.warn(`[Providers] Failed to load ${name}:`, err)
    }
  }

  console.log(`[Providers] Loaded ${loaded.length}/${providers.length} providers: ${loaded.join(', ')}`)
  return loaded
}
