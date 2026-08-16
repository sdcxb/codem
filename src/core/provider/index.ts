// @ts-nocheck
/**
 * Provider 插件包入口 — 导出所有独立 Provider 插件。
 *
 * 每个 Provider 是一个独立的 Cordis Plugin，可以单独加载/卸载/热替换。
 *
 * 加载策略：
 * - App.tsx 可以选择加载全部或部分 Provider
 * - 第三方插件可以注册更高优先级的 Provider 来替换默认实现
 * - Provider 可以在运行时被卸载和替换
 *
 * Provider 分类：
 * - Core Providers：核心业务服务（LLM/Tools/Session/Storage/Memory/Permission 等）
 * - Capability Providers：能力层服务（FS/Shell/Sandbox/Web/Compaction/Hooks 等）
 * - P6 Providers：扩展能力（Identity/LSP/CodeRuntime/Workflow/ContextInfo 等）
 * - R1 Providers：从 bridge-plugin.ts 迁移的独有服务（Guard/Credentials/Attachments 等）
 */

import type { Context, Plugin } from '../cordis/src/index.ts'

// ===== Core Providers =====
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

// ===== Capability Providers =====
export { fsProvider } from './fs-provider'
export { shellProvider } from './shell-provider'
export { sandboxProvider } from './sandbox-provider'
export { webProvider } from './web-provider'
export { compactionProvider } from './compaction-provider'
export { hooksProvider } from './hooks-provider'
export { approvalProvider } from './approval-provider'
export { permissionsProvider } from './permissions-provider'
export { automationProvider } from './automation-provider'

// ===== P6 Providers =====
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

// ===== R1 Providers (从 bridge-plugin.ts 迁移的独有服务) =====
export { guardProvider } from './guard-provider'
export { credentialsProvider } from './credentials-provider'
export { attachmentsProvider } from './attachments-provider'
export { scheduleProvider } from './schedule-provider'
export { plansProvider } from './plans-provider'
export { presetProvider } from './preset-provider'
export { hostClientProvider } from './host-client-provider'

// ===== R4 Providers (AgenticLoop 迁移到 ctx 消费的新增 Provider) =====
export { visionProxyProvider } from './vision-proxy-provider'
export { messageStorageProvider } from './message-storage-provider'
export { eventLogProvider } from './event-log-provider'
export { telemetryProvider } from './telemetry-provider'
export { securityModeProvider } from './security-mode-provider'
export { fileChangeTrackerProvider } from './file-change-tracker-provider'
export { transcriptCacheProvider } from './transcript-cache-provider'
export { agentEngineProvider } from './agent-engine-provider'
export { i18nProvider } from './i18n-provider'

/**
 * 加载所有默认 Provider。
 * 在 App.tsx 的 getCordisContext() 中调用。
 */
export function loadDefaultProviders(ctx: Context): string[] {
  const loaded: string[] = []
  const providers: Array<{ name: string; plugin: Plugin }> = [
    // Core Providers
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
    // Capability Providers
    { name: 'fs', plugin: fsProvider },
    { name: 'shell', plugin: shellProvider },
    { name: 'sandbox', plugin: sandboxProvider },
    { name: 'web', plugin: webProvider },
    { name: 'compaction', plugin: compactionProvider },
    { name: 'hooks', plugin: hooksProvider },
    { name: 'approval', plugin: approvalProvider },
    { name: 'permissions', plugin: permissionsProvider },
    { name: 'automation', plugin: automationProvider },
    // P6 Providers
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
    // R1 Providers (从 bridge-plugin.ts 迁移)
    { name: 'guard', plugin: guardProvider },
    { name: 'credentials', plugin: credentialsProvider },
    { name: 'attachments', plugin: attachmentsProvider },
    { name: 'schedule', plugin: scheduleProvider },
    { name: 'plans', plugin: plansProvider },
    { name: 'preset', plugin: presetProvider },
    { name: 'hostClient', plugin: hostClientProvider },
    // R4 Providers (AgenticLoop 迁移到 ctx 消费)
    { name: 'visionProxy', plugin: visionProxyProvider },
    { name: 'messageStorage', plugin: messageStorageProvider },
    { name: 'eventLog', plugin: eventLogProvider },
    { name: 'telemetry', plugin: telemetryProvider },
    { name: 'securityMode', plugin: securityModeProvider },
    { name: 'fileChangeTracker', plugin: fileChangeTrackerProvider },
    { name: 'transcriptCache', plugin: transcriptCacheProvider },
    { name: 'agentEngine', plugin: agentEngineProvider },
    { name: 'i18n', plugin: i18nProvider },
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
