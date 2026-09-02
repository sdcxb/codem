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
import { llmProvider } from './llm-provider'
import { toolsProvider } from './tools-provider'
import { sessionProvider } from './session-provider'
import { storageProvider } from './storage-provider'
import { memoryProvider } from './memory-provider'
import { permissionProvider } from './permission-provider'
import { mcpProvider } from './mcp-provider'
import { skillProvider } from './skill-provider'
import { subagentProvider } from './subagent-provider'
import { settingsProvider } from './settings-provider'
import { themeProvider } from './theme-provider'

// ===== Capability Providers =====
import { fsProvider } from './fs-provider'
import { shellProvider } from './shell-provider'
import { sandboxProvider } from './sandbox-provider'
import { webProvider } from './web-provider'
import { compactionProvider } from './compaction-provider'
import { hooksProvider } from './hooks-provider'
import { approvalProvider } from './approval-provider'
import { permissionsProvider } from './permissions-provider'
import { automationProvider } from './automation-provider'

// ===== P6 Providers =====
import { identityProvider } from './identity-provider'
import { lspProvider } from './lsp-provider'
import { codeRuntimeProvider } from './code-runtime-provider'
import { workflowProvider } from './workflow-provider'
import { contextInfoProvider } from './context-info-provider'
import { commandsProvider } from './commands-provider'
import { userQuestionsProvider } from './user-questions-provider'
import { notebookProvider } from './notebook-provider'
import { squadProvider } from './squad-provider'
import { squadManagerProvider } from './squad-provider'
import { dynamicRunnerProvider } from './dynamic-runner-provider'
import { pluginRegistryProvider } from './plugin-registry-provider'

// ===== R1 Providers (从 bridge-plugin.ts 迁移的独有服务) =====
import { guardProvider } from './guard-provider'
import { credentialsProvider } from './credentials-provider'
import { attachmentsProvider } from './attachments-provider'
import { scheduleProvider } from './schedule-provider'
import { plansProvider } from './plans-provider'
import { presetProvider } from './preset-provider'
import { hostClientProvider } from './host-client-provider'

// ===== R4 Providers (AgenticLoop 迁移到 ctx 消费的新增 Provider) =====
import { visionProxyProvider } from './vision-proxy-provider'
import { messageStorageProvider } from './message-storage-provider'
import { eventLogProvider } from './event-log-provider'
import { telemetryProvider } from './telemetry-provider'
import { securityModeProvider } from './security-mode-provider'
import { fileChangeTrackerProvider } from './file-change-tracker-provider'
import { transcriptCacheProvider } from './transcript-cache-provider'
import { agentEngineProvider } from './agent-engine-provider'
import { i18nProvider } from './i18n-provider'

// ===== R5 Providers: 从模块级单例升级为 Cordis 服务 =====
import { costTrackerProvider } from './cost-tracker-provider'
import { modelProfileProvider } from './model-profile-provider'
import { streamingExecutorProvider } from './streaming-executor-provider'
import { toolRenderProvider } from './tool-render-provider'
import { agentRegistryProvider } from './agent-registry-provider'
import { recoveryProvider } from './recovery-provider'
import { retryProvider } from './retry-provider'
import { issueProvider } from './issue-provider'
import { inboxProvider } from './inbox-provider'

// ===== R6: Zustand Store Cordis 服务化 =====
import { storeProvider } from './store-provider'

// ===== P1-7.4: LLM Provider 插件 =====
import { llmMimoProvider } from './llm-mimo-provider'
import { llmOpenAIProvider } from './llm-openai-provider'
import { llmRetryProvider } from './llm-retry-provider'
import { tokenMeterProvider } from './token-meter-provider'

// ===== P1-7.5: 会话层插件 =====
import { sessionPersistenceSqliteProvider } from './session-persistence-sqlite-provider'
import { sessionProjectionProvider } from './session-projection-provider'
import { sessionStatsProvider } from './session-stats-provider'
import { sessionTitleLLMProvider } from './session-title-llm-provider'
import { sessionCheckpointProvider } from './session-checkpoint-provider'

// ===== P1-7.6: Shell/终端插件 =====
import { pwshLocalProvider } from './pwsh-local-provider'
import { bashSandboxProvider } from './bash-sandbox-provider'

// ===== P1-7.7: 沙箱/安全插件 =====
import { sandboxPolicyProvider } from './sandbox-policy-provider'
import { subprocessProvider } from './subprocess-provider'

// ===== P1-7.8: 子 Agent 插件 =====
import { subagentForkInProcessProvider } from './subagent-fork-in-process-provider'
import { subagentSpawnInProcessProvider } from './subagent-spawn-in-process-provider'
import { toolSubagentControlProvider } from './tool-subagent-control-provider'

// ===== P1-7.9: 上下文/压缩插件 =====
import { compactionBasicProvider } from './compaction-basic-provider'
import { compactionToolResultPrunerProvider } from './compaction-tool-result-pruner-provider'
import { commandCompactProvider } from './command-compact-provider'

// ===== P1-7.10: 目标/计划/工作流插件 =====
import { goalRoundDriverProvider } from './goal-round-driver-provider'
import { commandGoalProvider } from './command-goal-provider'
import { planModeProvider } from './plan-mode-provider'

// ===== P2-7.11: Web/搜索插件 =====
import { webFetchHttpProvider } from './web-fetch-http-provider'
import { webSearchMimoProvider } from './web-search-mimo-provider'

// ===== P2-7.12: Guard/保护插件 =====
import { repeatToolReminderProvider } from './repeat-tool-reminder-provider'
import { timeoutGuardProvider } from './timeout-guard-provider'
import { invariantsGuardProvider } from './invariants-guard-provider'

// ===== P2-7.13: Host/Client 架构插件 =====
import { hostWebserverProvider } from './host-webserver-provider'
import { hostPluginInventoryProvider } from './host-plugin-inventory-provider'
import { sdkProtocolProvider } from './sdk-protocol-provider'

// ===== P2-7.14: UI 原语和面板插件 =====
import { uiPrimitivesProvider } from './ui-primitives-provider'
import { uiInputTriggerProvider } from './ui-input-trigger-provider'
import { uiAgentPresetProvider } from './ui-agent-preset-provider'
import { uiSkillPanelProvider } from './ui-skill-panel-provider'

// ===== P2-7.15: Typert 类型系统插件 =====
import { typertGeneratorProvider } from './typert-generator-provider'
import { typertLoaderProvider } from './typert-loader-provider'
import { typertProtocolProvider } from './typert-protocol-provider'
import { typertRegistryProvider } from './typert-registry-provider'

// ===== R7-1: 缺失 LLM 多模型适配器 =====
import { llmClaudeProvider } from './llm-claude-provider'
import { llmGeminiProvider } from './llm-gemini-provider'
import { llmOllamaProvider } from './llm-ollama-provider'

// ===== R7-2: 会话恢复插件 =====
import { sessionRecoveryProvider } from './session-recovery-provider'

// ===== R7-3: 缺失 UI 组件插件 =====
import { uiDirectoryPickerProvider } from './ui-directory-picker-provider'
import { uiMessageFeedbackProvider } from './ui-message-feedback-provider'
import { uiModelSelectionProvider } from './ui-model-selection-provider'
import { uiPermissionPresetsProvider } from './ui-permission-presets-provider'
import { uiTrajectoryProvider } from './ui-trajectory-provider'
import { uiDeliverablesProvider } from './ui-deliverables-provider'

// ===== R7-4: Host/Client 链路拆分 =====
import { bundleProvider } from './bundle-provider'
import { acpProvider } from './acp-provider'
import { hostProvider } from './host-provider'
import { remoteClientProvider } from './remote-client-provider'

// ===== R7-7: CLI 入口插件 =====
import { cliProvider } from './cli-provider'

// Re-export all providers for external consumers
export {
  llmProvider, toolsProvider, sessionProvider, storageProvider, memoryProvider,
  permissionProvider, mcpProvider, skillProvider, subagentProvider, settingsProvider, themeProvider,
  fsProvider, shellProvider, sandboxProvider, webProvider, compactionProvider, hooksProvider,
  approvalProvider, permissionsProvider, automationProvider, identityProvider, lspProvider,
  codeRuntimeProvider, workflowProvider, contextInfoProvider, commandsProvider, userQuestionsProvider,
  notebookProvider, squadProvider, dynamicRunnerProvider, pluginRegistryProvider, guardProvider,
  credentialsProvider, attachmentsProvider, scheduleProvider, plansProvider, presetProvider,
  hostClientProvider, visionProxyProvider, messageStorageProvider, eventLogProvider, telemetryProvider,
  securityModeProvider, fileChangeTrackerProvider, transcriptCacheProvider, agentEngineProvider,
  i18nProvider, costTrackerProvider, modelProfileProvider, streamingExecutorProvider, toolRenderProvider,
  agentRegistryProvider, recoveryProvider, retryProvider, squadManagerProvider, issueProvider,
  inboxProvider, storeProvider, llmMimoProvider, llmOpenAIProvider, llmRetryProvider, tokenMeterProvider,
  sessionPersistenceSqliteProvider, sessionProjectionProvider, sessionStatsProvider, sessionTitleLLMProvider,
  sessionCheckpointProvider, pwshLocalProvider, bashSandboxProvider,
  sandboxPolicyProvider, subprocessProvider, subagentForkInProcessProvider, subagentSpawnInProcessProvider,
  toolSubagentControlProvider, compactionBasicProvider, compactionToolResultPrunerProvider,
  commandCompactProvider, goalRoundDriverProvider, commandGoalProvider, planModeProvider,
  webFetchHttpProvider, webSearchMimoProvider, repeatToolReminderProvider, timeoutGuardProvider,
  invariantsGuardProvider, hostWebserverProvider, hostPluginInventoryProvider, sdkProtocolProvider,
  uiPrimitivesProvider, uiInputTriggerProvider, uiAgentPresetProvider, uiSkillPanelProvider,
  typertGeneratorProvider, typertLoaderProvider, typertProtocolProvider, typertRegistryProvider,
  llmClaudeProvider, llmGeminiProvider, llmOllamaProvider, sessionRecoveryProvider,
  uiDirectoryPickerProvider, uiMessageFeedbackProvider, uiModelSelectionProvider,
  uiPermissionPresetsProvider, uiTrajectoryProvider, uiDeliverablesProvider,
  bundleProvider, acpProvider, hostProvider, remoteClientProvider, cliProvider,
}

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

  // ====== Fiber 状态变更诊断日志 ======
  // 监听 internal/status 事件，当 fiber 状态变化时输出日志。
  // 让时序问题从"玄学"变"可见"：哪个 fiber 卡在 PENDING，哪个 FAILED，一目了然。
  try {
    const stateNames = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
    ctx.on('internal/status', (fiber: any, oldState: number) => {
      const name = fiber?.name || 'unknown'
      const newState = stateNames[fiber?.state] || `UNKNOWN(${fiber?.state})`
      const oldName = stateNames[oldState] || `UNKNOWN(${oldState})`
      // 只在状态变化为非 ACTIVE 或从非 ACTIVE 变为 ACTIVE 时输出（减少噪音）
      if (newState === 'FAILED') {
        console.error(`[Fiber] ${name}: ${oldName} → ${newState}`, fiber?._error || '')
      } else if (newState === 'PENDING' && oldState !== 0) {
        // 从其他状态变回 PENDING，说明依赖丢失
        console.warn(`[Fiber] ${name}: ${oldName} → ${newState} (dependency lost)`)
      }
    })
  } catch (e) { console.warn('[index.ts] Failed to register fiber status listener:', e) }

  return loaded
}
