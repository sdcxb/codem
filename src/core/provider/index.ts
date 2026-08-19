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

// ===== R5 Providers: 从模块级单例升级为 Cordis 服务 =====
export { costTrackerProvider } from './cost-tracker-provider'
export { modelProfileProvider } from './model-profile-provider'
export { streamingExecutorProvider } from './streaming-executor-provider'
export { toolRenderProvider } from './tool-render-provider'
export { agentRegistryProvider } from './agent-registry-provider'
export { recoveryProvider } from './recovery-provider'
export { retryProvider } from './retry-provider'
export { squadProvider as squadManagerProvider } from './squad-provider'
export { issueProvider } from './issue-provider'
export { inboxProvider } from './inbox-provider'

// ===== R6: Zustand Store Cordis 服务化 =====
export { storeProvider } from './store-provider'

// ===== P1-7.4: LLM Provider 插件 =====
export { llmMimoProvider } from './llm-mimo-provider'
export { llmOpenAIProvider } from './llm-openai-provider'
export { llmRetryProvider } from './llm-retry-provider'
export { tokenMeterProvider } from './token-meter-provider'

// ===== P1-7.5: 会话层插件 =====
export { sessionPersistenceSqliteProvider } from './session-persistence-sqlite-provider'
export { sessionProjectionProvider } from './session-projection-provider'
export { sessionStatsProvider } from './session-stats-provider'
export { sessionTitleLLMProvider } from './session-title-llm-provider'
export { sessionCheckpointProvider } from './session-checkpoint-provider'

// ===== P1-7.6: Shell/终端插件 =====
export { pwshLocalProvider } from './pwsh-local-provider'
export { bashSandboxProvider } from './bash-sandbox-provider'
export { terminalBashProvider } from './terminal-bash-provider'

// ===== P1-7.7: 沙箱/安全插件 =====
export { sandboxPolicyProvider } from './sandbox-policy-provider'
export { subprocessProvider } from './subprocess-provider'

// ===== P1-7.8: 子 Agent 插件 =====
export { subagentForkInProcessProvider } from './subagent-fork-in-process-provider'
export { subagentSpawnInProcessProvider } from './subagent-spawn-in-process-provider'
export { toolSubagentControlProvider } from './tool-subagent-control-provider'

// ===== P1-7.9: 上下文/压缩插件 =====
export { compactionBasicProvider } from './compaction-basic-provider'
export { compactionToolResultPrunerProvider } from './compaction-tool-result-pruner-provider'
export { commandCompactProvider } from './command-compact-provider'

// ===== P1-7.10: 目标/计划/工作流插件 =====
export { goalRoundDriverProvider } from './goal-round-driver-provider'
export { commandGoalProvider } from './command-goal-provider'
export { planModeProvider } from './plan-mode-provider'

// ===== P2-7.11: Web/搜索插件 =====
export { webFetchHttpProvider } from './web-fetch-http-provider'
export { webSearchMimoProvider } from './web-search-mimo-provider'

// ===== P2-7.12: Guard/保护插件 =====
export { repeatToolReminderProvider } from './repeat-tool-reminder-provider'
export { timeoutGuardProvider } from './timeout-guard-provider'
export { invariantsGuardProvider } from './invariants-guard-provider'

// ===== P2-7.13: Host/Client 架构插件 =====
export { hostWebserverProvider } from './host-webserver-provider'
export { hostPluginInventoryProvider } from './host-plugin-inventory-provider'
export { sdkProtocolProvider } from './sdk-protocol-provider'

// ===== P2-7.14: UI 原语和面板插件 =====
export { uiPrimitivesProvider } from './ui-primitives-provider'
export { uiInputTriggerProvider } from './ui-input-trigger-provider'
export { uiAgentPresetProvider } from './ui-agent-preset-provider'
export { uiSkillPanelProvider } from './ui-skill-panel-provider'

// ===== P2-7.15: Typert 类型系统插件 =====
export { typertGeneratorProvider } from './typert-generator-provider'
export { typertLoaderProvider } from './typert-loader-provider'
export { typertProtocolProvider } from './typert-protocol-provider'
export { typertRegistryProvider } from './typert-registry-provider'

// ===== R7-1: 缺失 LLM 多模型适配器 =====
export { llmClaudeProvider } from './llm-claude-provider'
export { llmGeminiProvider } from './llm-gemini-provider'
export { llmOllamaProvider } from './llm-ollama-provider'

// ===== R7-2: 会话恢复插件 =====
export { sessionRecoveryProvider } from './session-recovery-provider'

// ===== R7-3: 缺失 UI 组件插件 =====
export { uiDirectoryPickerProvider } from './ui-directory-picker-provider'
export { uiMessageFeedbackProvider } from './ui-message-feedback-provider'
export { uiModelSelectionProvider } from './ui-model-selection-provider'
export { uiPermissionPresetsProvider } from './ui-permission-presets-provider'
export { uiTrajectoryProvider } from './ui-trajectory-provider'
export { uiDeliverablesProvider } from './ui-deliverables-provider'

// ===== R7-4: Host/Client 链路拆分 =====
export { bundleProvider } from './bundle-provider'
export { acpProvider } from './acp-provider'
export { hostProvider } from './host-provider'
export { remoteClientProvider } from './remote-client-provider'

// ===== R7-7: CLI 入口插件 =====
export { cliProvider } from './cli-provider'

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
    // R5 Providers: 从模块级单例升级为 Cordis 服务
    { name: 'costTracker', plugin: costTrackerProvider },
    { name: 'modelProfile', plugin: modelProfileProvider },
    { name: 'streamingExecutor', plugin: streamingExecutorProvider },
    { name: 'toolRender', plugin: toolRenderProvider },
    { name: 'agentRegistry', plugin: agentRegistryProvider },
    { name: 'recovery', plugin: recoveryProvider },
    { name: 'retry', plugin: retryProvider },
    { name: 'squadManager', plugin: squadManagerProvider },
    { name: 'issue', plugin: issueProvider },
    { name: 'inbox', plugin: inboxProvider },
    // R6: Zustand Store
    { name: 'store', plugin: storeProvider },
    // P1-7.4: LLM Provider 插件
    { name: 'llmMimo', plugin: llmMimoProvider },
    { name: 'llmOpenAI', plugin: llmOpenAIProvider },
    { name: 'llmRetry', plugin: llmRetryProvider },
    { name: 'tokenMeter', plugin: tokenMeterProvider },
    // P1-7.5: 会话层插件
    { name: 'sessionPersistence', plugin: sessionPersistenceSqliteProvider },
    { name: 'sessionProjection', plugin: sessionProjectionProvider },
    { name: 'sessionStats', plugin: sessionStatsProvider },
    { name: 'sessionTitleLLM', plugin: sessionTitleLLMProvider },
    { name: 'sessionCheckpoint', plugin: sessionCheckpointProvider },
    // P1-7.6: Shell/终端插件
    { name: 'pwshLocal', plugin: pwshLocalProvider },
    { name: 'bashSandbox', plugin: bashSandboxProvider },
    { name: 'terminalBash', plugin: terminalBashProvider },
    // P1-7.7: 沙箱/安全插件
    { name: 'sandboxPolicy', plugin: sandboxPolicyProvider },
    { name: 'subprocess', plugin: subprocessProvider },
    // P1-7.8: 子 Agent 插件
    { name: 'subagentForkInProcess', plugin: subagentForkInProcessProvider },
    { name: 'subagentSpawnInProcess', plugin: subagentSpawnInProcessProvider },
    { name: 'subagentControl', plugin: toolSubagentControlProvider },
    // P1-7.9: 上下文/压缩插件
    { name: 'compactionBasic', plugin: compactionBasicProvider },
    { name: 'compactionToolResultPruner', plugin: compactionToolResultPrunerProvider },
    { name: 'commandCompact', plugin: commandCompactProvider },
    // P1-7.10: 目标/计划/工作流插件
    { name: 'goalRoundDriver', plugin: goalRoundDriverProvider },
    { name: 'commandGoal', plugin: commandGoalProvider },
    { name: 'planMode', plugin: planModeProvider },
    // P2-7.11: Web/搜索插件
    { name: 'webFetchHttp', plugin: webFetchHttpProvider },
    { name: 'webSearchMimo', plugin: webSearchMimoProvider },
    // P2-7.12: Guard/保护插件
    { name: 'repeatToolReminder', plugin: repeatToolReminderProvider },
    { name: 'timeoutGuard', plugin: timeoutGuardProvider },
    { name: 'invariantsGuard', plugin: invariantsGuardProvider },
    // P2-7.13: Host/Client 架构插件
    { name: 'hostWebserver', plugin: hostWebserverProvider },
    { name: 'hostPluginInventory', plugin: hostPluginInventoryProvider },
    { name: 'sdkProtocol', plugin: sdkProtocolProvider },
    // P2-7.14: UI 原语和面板插件
    { name: 'uiPrimitives', plugin: uiPrimitivesProvider },
    { name: 'uiInputTrigger', plugin: uiInputTriggerProvider },
    { name: 'uiAgentPreset', plugin: uiAgentPresetProvider },
    { name: 'uiSkillPanel', plugin: uiSkillPanelProvider },
    // P2-7.15: Typert 类型系统插件
    { name: 'typertGenerator', plugin: typertGeneratorProvider },
    { name: 'typertLoader', plugin: typertLoaderProvider },
    { name: 'typertProtocol', plugin: typertProtocolProvider },
    { name: 'typertRegistry', plugin: typertRegistryProvider },
    // R7-1: 缺失 LLM 多模型适配器
    { name: 'llmClaude', plugin: llmClaudeProvider },
    { name: 'llmGemini', plugin: llmGeminiProvider },
    { name: 'llmOllama', plugin: llmOllamaProvider },
    // R7-2: 会话恢复插件
    { name: 'sessionRecovery', plugin: sessionRecoveryProvider },
    // R7-3: 缺失 UI 组件插件
    { name: 'uiDirectoryPicker', plugin: uiDirectoryPickerProvider },
    { name: 'uiMessageFeedback', plugin: uiMessageFeedbackProvider },
    { name: 'uiModelSelection', plugin: uiModelSelectionProvider },
    { name: 'uiPermissionPresets', plugin: uiPermissionPresetsProvider },
    { name: 'uiTrajectory', plugin: uiTrajectoryProvider },
    { name: 'uiDeliverables', plugin: uiDeliverablesProvider },
    // R7-4: Host/Client 链路拆分
    { name: 'bundle', plugin: bundleProvider },
    { name: 'acp', plugin: acpProvider },
    { name: 'host', plugin: hostProvider },
    { name: 'remoteClient', plugin: remoteClientProvider },
    // R7-7: CLI 入口插件
    { name: 'cli', plugin: cliProvider },
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

  // P0-6.6: 必需 Provider 列表 — 不允许卸载（文档 6.4 核心链路 + 6.5 建议1）
  const requiredProviders = ['llm', 'tools', 'messageStorage', 'session', 'store']

  // P0-6.6: Provider 卸载事件监听 — 通知 AgenticLoop 和 UI（文档 6.6 检查清单）
  try {
    ctx.on('internal/plugin', (fiber: any) => {
      const pluginName = fiber?.config?.name || fiber?.name || 'unknown'
      if (requiredProviders.includes(pluginName)) {
        console.warn(`[Cordis] Required provider "${pluginName}" is being unloaded! Core functionality will be broken.`)
      }
      // 通知 AgenticLoop：通过事件总线广播 service/unload 事件
      try {
        ctx.emit('service/unload', { name: pluginName, fiber })
      } catch (e) { console.warn('[index.ts]', e) }

      // P2-6.6: 事件日志记录 Provider 变更
      try {
        const eventLog = ctx.get('eventLog')
        if (eventLog) {
          eventLog.record?.({
            type: 'provider_change',
            action: 'unload',
            name: pluginName,
            timestamp: Date.now(),
          })
        }
      } catch (e) { console.warn('[index.ts]', e) }
    })
  } catch (e) { console.warn('[index.ts]', e) }

  // P2-6.6: 恢复点保存 Provider 配置快照
  try {
    const snapshot = {
      loadedProviders: [...loaded],
      requiredProviders,
      timestamp: Date.now(),
    }
    const recovery = ctx.get('recovery')
    if (recovery) {
      recovery.saveCheckpoint?.('provider-config', snapshot)
    }
    // 存储到全局以便恢复
    ;(globalThis as any).__codemProviderSnapshot = snapshot
  } catch (e) { console.warn('[index.ts]', e) }

  // P2-6.6: Provider 热替换自动重试
  // 当 LLM 调用失败时检查 ctx.get('llm') 是否有新 Provider 注册，自动重试
  try {
    ctx.on('service/reload', (data: any) => {
      if (data?.name === 'llm') {
        console.log(`[Cordis] LLM provider reloaded, notifying AgenticLoop to retry`)
        ctx.emit('service/retry', { name: 'llm', reason: 'provider_reloaded' })
      }
    })
  } catch (e) { console.warn('[index.ts]', e) }

  return loaded
}
