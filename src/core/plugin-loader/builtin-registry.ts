// @ts-nocheck
/**
 * 内置插件注册 — 将所有 Codem 内置插件注册到 PluginLoader。
 *
 * 这使 PluginLoader 可以通过 codem.yml 发现和加载所有内置插件，
 * 而不需要真实的 node_modules 包。
 */

import { registerBuiltinPlugin, getBuiltinPluginCount } from './index.ts'

// Core Providers
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

// Capability Providers
import { fsProvider } from '../provider/fs-provider'
import { shellProvider } from '../provider/shell-provider'
import { sandboxProvider } from '../provider/sandbox-provider'
import { webProvider } from '../provider/web-provider'
import { compactionProvider } from '../provider/compaction-provider'
import { hooksProvider } from '../provider/hooks-provider'
import { approvalProvider } from '../provider/approval-provider'
import { permissionsProvider } from '../provider/permissions-provider'
import { automationProvider } from '../provider/automation-provider'

// P6 Providers
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

// R1 Providers (从 bridge-plugin.ts 迁移)
import { guardProvider } from '../provider/guard-provider'
import { credentialsProvider } from '../provider/credentials-provider'
import { attachmentsProvider } from '../provider/attachments-provider'
import { scheduleProvider } from '../provider/schedule-provider'
import { plansProvider } from '../provider/plans-provider'
import { presetProvider } from '../provider/preset-provider'
import { hostClientProvider } from '../provider/host-client-provider'

// R4 Providers (AgenticLoop 迁移到 ctx 消费)
import { visionProxyProvider } from '../provider/vision-proxy-provider'
import { messageStorageProvider } from '../provider/message-storage-provider'
import { eventLogProvider } from '../provider/event-log-provider'
import { telemetryProvider } from '../provider/telemetry-provider'
import { securityModeProvider } from '../provider/security-mode-provider'
import { fileChangeTrackerProvider } from '../provider/file-change-tracker-provider'
import { transcriptCacheProvider } from '../provider/transcript-cache-provider'
import { agentEngineProvider } from '../provider/agent-engine-provider'
import { i18nProvider } from '../provider/i18n-provider'

// R5 Providers (从模块级单例升级为 Cordis 服务)
import { costTrackerProvider } from '../provider/cost-tracker-provider'
import { modelProfileProvider } from '../provider/model-profile-provider'
import { streamingExecutorProvider } from '../provider/streaming-executor-provider'
import { toolRenderProvider } from '../provider/tool-render-provider'
import { agentRegistryProvider } from '../provider/agent-registry-provider'
import { recoveryProvider } from '../provider/recovery-provider'
import { retryProvider } from '../provider/retry-provider'
import { squadManagerProvider } from '../provider/squad-provider'
import { issueProvider } from '../provider/issue-provider'
import { inboxProvider } from '../provider/inbox-provider'

// R6: Zustand Store Cordis 服务化
import { storeProvider } from '../provider/store-provider'

// P1-7.4: LLM Provider 插件
import { llmMimoProvider } from '../provider/llm-mimo-provider'
import { mimoAuthProvider } from '../provider/mimo-auth-provider'
import { llmOpenAIProvider } from '../provider/llm-openai-provider'
import { llmRetryProvider } from '../provider/llm-retry-provider'
import { tokenMeterProvider } from '../provider/token-meter-provider'

// P1-7.5: 会话层插件
import { sessionPersistenceSqliteProvider } from '../provider/session-persistence-sqlite-provider'
import { sessionProjectionProvider } from '../provider/session-projection-provider'
import { sessionStatsProvider } from '../provider/session-stats-provider'
import { sessionTitleLLMProvider } from '../provider/session-title-llm-provider'
import { sessionCheckpointProvider } from '../provider/session-checkpoint-provider'

// P1-7.6: Shell/终端插件
import { pwshLocalProvider } from '../provider/pwsh-local-provider'
import { bashSandboxProvider } from '../provider/bash-sandbox-provider'
import { terminalBashProvider } from '../provider/terminal-bash-provider'

// P1-7.7: 沙箱/安全插件
import { sandboxPolicyProvider } from '../provider/sandbox-policy-provider'
import { subprocessProvider } from '../provider/subprocess-provider'

// P1-7.8: 子 Agent 插件
import { subagentForkInProcessProvider } from '../provider/subagent-fork-in-process-provider'
import { subagentSpawnInProcessProvider } from '../provider/subagent-spawn-in-process-provider'
import { toolSubagentControlProvider } from '../provider/tool-subagent-control-provider'

// P1-7.9: 上下文/压缩插件
import { compactionBasicProvider } from '../provider/compaction-basic-provider'
import { compactionToolResultPrunerProvider } from '../provider/compaction-tool-result-pruner-provider'
import { commandCompactProvider } from '../provider/command-compact-provider'

// P1-7.10: 目标/计划/工作流插件
import { goalRoundDriverProvider } from '../provider/goal-round-driver-provider'
import { commandGoalProvider } from '../provider/command-goal-provider'
import { planModeProvider } from '../provider/plan-mode-provider'

// P2-7.11: Web/搜索插件
import { webFetchHttpProvider } from '../provider/web-fetch-http-provider'
import { webSearchMimoProvider } from '../provider/web-search-mimo-provider'

// P2-7.12: Guard/保护插件
import { repeatToolReminderProvider } from '../provider/repeat-tool-reminder-provider'
import { timeoutGuardProvider } from '../provider/timeout-guard-provider'
import { invariantsGuardProvider } from '../provider/invariants-guard-provider'

// P2-7.13: Host/Client 架构插件
import { hostWebserverProvider } from '../provider/host-webserver-provider'
import { hostPluginInventoryProvider } from '../provider/host-plugin-inventory-provider'
import { sdkProtocolProvider } from '../provider/sdk-protocol-provider'

// P2-7.14: UI 原语和面板插件
import { uiPrimitivesProvider } from '../provider/ui-primitives-provider'
import { uiInputTriggerProvider } from '../provider/ui-input-trigger-provider'
import { uiAgentPresetProvider } from '../provider/ui-agent-preset-provider'
import { uiSkillPanelProvider } from '../provider/ui-skill-panel-provider'

// P2-7.15: Typert 类型系统插件
import { typertGeneratorProvider } from '../provider/typert-generator-provider'
import { typertLoaderProvider } from '../provider/typert-loader-provider'
import { typertProtocolProvider } from '../provider/typert-protocol-provider'
import { typertRegistryProvider } from '../provider/typert-registry-provider'

// R7-1: 缺失 LLM 多模型适配器
import { llmClaudeProvider } from '../provider/llm-claude-provider'
import { llmGeminiProvider } from '../provider/llm-gemini-provider'
import { llmOllamaProvider } from '../provider/llm-ollama-provider'

// R7-2: 会话恢复插件
import { sessionRecoveryProvider } from '../provider/session-recovery-provider'

// R7-3: 缺失 UI 组件插件
import { uiDirectoryPickerProvider } from '../provider/ui-directory-picker-provider'
import { uiMessageFeedbackProvider } from '../provider/ui-message-feedback-provider'
import { uiModelSelectionProvider } from '../provider/ui-model-selection-provider'
import { uiPermissionPresetsProvider } from '../provider/ui-permission-presets-provider'
import { uiTrajectoryProvider } from '../provider/ui-trajectory-provider'
import { uiDeliverablesProvider } from '../provider/ui-deliverables-provider'

// R7-4: Host/Client 链路拆分
import { bundleProvider } from '../provider/bundle-provider'
import { acpProvider } from '../provider/acp-provider'
import { hostProvider } from '../provider/host-provider'
import { remoteClientProvider } from '../provider/remote-client-provider'

// R7-7: CLI 入口插件
import { cliProvider } from '../provider/cli-provider'

// UI Plugins — static imports (browser-compatible, no require())
import { apply as uiSidebarApply } from '../ui-plugins/ui-sidebar/index.ts'
import { apply as uiConversationApply } from '../ui-plugins/ui-conversation/index.ts'
import { apply as uiToolApply } from '../ui-plugins/ui-tool/index.ts'
import { apply as uiSettingsApply } from '../ui-plugins/ui-settings/index.ts'
import { apply as uiMiscApply } from '../ui-plugins/ui-misc/index.ts'
import { apply as uiMarketApply } from '../ui-plugins/ui-market/index.ts'
import { apply as uiThemeApply } from '../ui-plugins/ui-theme/index.ts'
import { apply as uiSkinDefaultApply } from '../ui-plugins/ui-skin-default/index.ts'
import { apply as uiSkinPetApply } from '../ui-plugins/ui-skin-pet/index.ts'
// ui-pet is now a Provider (ui-pet-provider.ts), not a slot-based UI plugin

// R8: 78 个 DSH 缺失插件补全
import { agentLoopProvider } from '../provider/agent-loop-provider'
import { agentProvider } from '../provider/agent-provider'
import { agentDefaultModelProvider } from '../provider/agent-default-model-provider'
import { agentToolPresentationProvider } from '../provider/agent-tool-presentation-provider'
import { agentInstructionsProvider } from '../provider/agent-instructions-provider'
import { systemPromptProvider } from '../provider/system-prompt-provider'
import { scopeProvider } from '../provider/scope-provider'
import { sessionPersistenceJsonlProvider } from '../provider/session-persistence-jsonl-provider'
import { sessionProjectionCacheProvider } from '../provider/session-projection-cache-provider'
import { sessionQuerySqliteProvider } from '../provider/session-query-sqlite-provider'
import { sessionLogExportProvider } from '../provider/session-log-export-provider'
import { sessionReferenceProvider } from '../provider/session-reference-provider'
import { sessionTelemetryOtelProvider } from '../provider/session-telemetry-otel-provider'
import { sessionTitleFirstPromptLlmProvider } from '../provider/session-title-first-prompt-llm-provider'
import { sessionTitleAllPromptsLlmProvider } from '../provider/session-title-all-prompts-llm-provider'
import { sessionCheckpointPolicyProvider } from '../provider/session-checkpoint-policy-provider'
import { pwshSandboxProvider } from '../provider/pwsh-sandbox-provider'
import { toolBashPersistentProvider } from '../provider/tool-bash-persistent-provider'
import { tmuxContextProvider } from '../provider/tmux-context-provider'
import { fsObservationPolicyProvider } from '../provider/fs-observation-policy-provider'
import { fsSandboxProvider } from '../provider/fs-sandbox-provider'
import { toolFsSearchProvider } from '../provider/tool-fs-search-provider'
import { toolStrReplaceEditorProvider } from '../provider/tool-str-replace-editor-provider'
import { sandboxWindowsAclProvider } from '../provider/sandbox-windows-acl-provider'
import { e2bProvider } from '../provider/e2b-provider'
import { fsE2bProvider } from '../provider/fs-e2b-provider'
import { subprocessE2bProvider } from '../provider/subprocess-e2b-provider'
import { subprocessLocalProvider } from '../provider/subprocess-local-provider'
import { subagentAcpProvider } from '../provider/subagent-acp-provider'
import { subagentClaudeCodeProvider } from '../provider/subagent-claude-code-provider'
import { subagentCodexProvider } from '../provider/subagent-codex-provider'
import { subagentDshSdkProvider } from '../provider/subagent-dsh-sdk-provider'
import { subagentInProcessDriverProvider } from '../provider/subagent-in-process-driver-provider'
import { toolSubagentReportProvider } from '../provider/tool-subagent-report-provider'
import { llmDeepseekProvider } from '../provider/llm-deepseek-provider'
import { llmPiAiProvider } from '../provider/llm-pi-ai-provider'
import { webSearchExaProvider } from '../provider/web-search-exa-provider'
import { webSearchPerplexityProvider } from '../provider/web-search-perplexity-provider'
import { timeContextProvider } from '../provider/time-context-provider'
import { toolRalphProvider } from '../provider/tool-ralph-provider'
import { workflowWorkerThreadProvider } from '../provider/workflow-worker-thread-provider'
import { codeRuntimeWorkerThreadProvider } from '../provider/code-runtime-worker-thread-provider'
import { spillProvider } from '../provider/spill-provider'
import { spillLocalProvider } from '../provider/spill-local-provider'
import { spillPolicyProvider } from '../provider/spill-policy-provider'
import { toolCallTimeoutPolicyProvider } from '../provider/tool-call-timeout-policy-provider'
import { hostApiproxyProvider } from '../provider/host-apiproxy-provider'
import { hostFrontendStaticProvider } from '../provider/host-frontend-static-provider'
import { sdkClientProvider } from '../provider/sdk-client-provider'
import { apiGatewayProvider } from '../provider/api-gateway-provider'
import { apiRemotesProvider } from '../provider/api-remotes-provider'
import { uiAttachmentProvider } from '../provider/ui-attachment-provider'
import { uiCordisProvider } from '../provider/ui-cordis-provider'
import { uiGoalProvider } from '../provider/ui-goal-provider'
import { uiJobsProvider } from '../provider/ui-jobs-provider'
import { uiLayoutProvider } from '../provider/ui-layout-provider'
import { uiPlanProvider } from '../provider/ui-plan-provider'
import { uiSettingsGeneralProvider } from '../provider/ui-settings-general-provider'
import { uiSettingsModelsProvider } from '../provider/ui-settings-models-provider'
import { uiSettingsPluginInventoryProvider } from '../provider/ui-settings-plugin-inventory-provider'
import { uiSettingsPluginsProvider } from '../provider/ui-settings-plugins-provider'
import { uiSlotsProvider } from '../provider/ui-slots-provider'
import { uiSubagentProvider } from '../provider/ui-subagent-provider'
import { uiUserQuestionsProvider } from '../provider/ui-user-questions-provider'
import { uiWorkflowRunProvider } from '../provider/ui-workflow-run-provider'
import { uiWorkspaceProvider } from '../provider/ui-workspace-provider'
import { lspStdioProvider } from '../provider/lsp-stdio-provider'
import { atomicWriteProvider } from '../provider/atomic-write-provider'
import { userApprovalProvider } from '../provider/user-approval-provider'
import { skillBadgeProvider } from '../provider/skill-badge-provider'
import { skillFilesystemProvider } from '../provider/skill-filesystem-provider'
import { personaProvider } from '../provider/persona-provider'
import { commandFeedbackProvider } from '../provider/command-feedback-provider'
import { cordisClientRunnerProvider } from '../provider/cordis-client-runner-provider'
import { cordisHostRunnerProvider } from '../provider/cordis-host-runner-provider'
import { toolJobsProvider } from '../provider/tool-jobs-provider'
import { storageDomainProvider } from '../provider/storage-domain-provider'
import { storageJsonProvider } from '../provider/storage-json-provider'
import { uiGameProvider } from '../provider/ui-game-provider'

/** 注册所有内置插件到 PluginLoader */
export function registerBuiltinPlugins() {
  // Core Providers
  registerBuiltinPlugin('@codem/llm', { provides: ['llm'], inject: ['llmEngine'], priority: 0, hot: true }, () => llmProvider)
  registerBuiltinPlugin('@codem/tools', { provides: ['tools'], inject: ['llmEngine'], priority: 0, hot: true }, () => toolsProvider)
  registerBuiltinPlugin('@codem/session', { provides: ['session'], inject: [], priority: 0, hot: true }, () => sessionProvider)
  registerBuiltinPlugin('@codem/storage', { provides: ['storage'], inject: [], priority: 0, hot: true }, () => storageProvider)
  registerBuiltinPlugin('@codem/memory', { provides: ['memory'], inject: ['llmEngine'], priority: 0, hot: true }, () => memoryProvider)
  registerBuiltinPlugin('@codem/permission', { provides: ['permission'], inject: ['llmEngine'], priority: 0, hot: true }, () => permissionProvider)
  registerBuiltinPlugin('@codem/mcp', { provides: ['mcp'], inject: ['llmEngine'], priority: 0, hot: true }, () => mcpProvider)
  registerBuiltinPlugin('@codem/skill', { provides: ['skill'], inject: ['llmEngine'], priority: 0, hot: true }, () => skillProvider)
  registerBuiltinPlugin('@codem/subagent', { provides: ['subagent'], inject: ['llmEngine'], priority: 0, hot: true }, () => subagentProvider)
  registerBuiltinPlugin('@codem/settings', { provides: ['settings'], inject: ['llmEngine'], priority: 0, hot: true }, () => settingsProvider)
  registerBuiltinPlugin('@codem/theme', { provides: ['theme'], inject: [], priority: 0, hot: true }, () => themeProvider)
registerBuiltinPlugin('@codem/mimo-auth', { provides: ['mimoAuth'], inject: [], priority: 0, hot: true }, () => mimoAuthProvider)

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

  // R1 Providers (从 bridge-plugin.ts 迁移)
  registerBuiltinPlugin('@codem/guard', { provides: ['guard'], inject: [], priority: 0 }, () => guardProvider)
  registerBuiltinPlugin('@codem/credentials', { provides: ['credentials'], inject: [], priority: 0 }, () => credentialsProvider)
  registerBuiltinPlugin('@codem/attachments', { provides: ['attachments'], inject: [], priority: 0 }, () => attachmentsProvider)
  registerBuiltinPlugin('@codem/schedule', { provides: ['schedule'], inject: [], priority: 0 }, () => scheduleProvider)
  registerBuiltinPlugin('@codem/plans', { provides: ['plans'], inject: [], priority: 0 }, () => plansProvider)
  registerBuiltinPlugin('@codem/preset', { provides: ['preset'], inject: [], priority: 0 }, () => presetProvider)
  registerBuiltinPlugin('@codem/host-client', { provides: ['hostClient', 'pluginInstaller', 'bundle', 'sdk', 'acp', 'host', 'client'], inject: [], priority: 0 }, () => hostClientProvider)

  // R4 Providers (AgenticLoop 迁移到 ctx 消费)
  registerBuiltinPlugin('@codem/vision-proxy', { provides: ['visionProxy'], inject: [], priority: 0, hot: true }, () => visionProxyProvider)
  registerBuiltinPlugin('@codem/message-storage', { provides: ['messageStorage'], inject: [], priority: 0, hot: true }, () => messageStorageProvider)
  registerBuiltinPlugin('@codem/event-log', { provides: ['eventLog'], inject: [], priority: 0, hot: true }, () => eventLogProvider)
  registerBuiltinPlugin('@codem/telemetry', { provides: ['telemetry'], inject: [], priority: 0, hot: true }, () => telemetryProvider)
  registerBuiltinPlugin('@codem/security-mode', { provides: ['securityMode'], inject: [], priority: 0, hot: true }, () => securityModeProvider)
  registerBuiltinPlugin('@codem/file-change-tracker', { provides: ['fileChangeTracker'], inject: [], priority: 0, hot: true }, () => fileChangeTrackerProvider)
  registerBuiltinPlugin('@codem/transcript-cache', { provides: ['transcriptCache'], inject: [], priority: 0, hot: true }, () => transcriptCacheProvider)
  registerBuiltinPlugin('@codem/agent-engine', { provides: ['agentEngine'], inject: [], priority: 0, hot: true }, () => agentEngineProvider)
  registerBuiltinPlugin('@codem/i18n', { provides: ['i18n'], inject: [], priority: 0, hot: true }, () => i18nProvider)

  // UI Plugins — 对标 DSH 的 ui-* 插件包：
  // 每个 UI 插件的 apply 函数接收 ctx 参数，通过 ctx.get('slots') 注册组件。
  // 包装为 { inject: ['slots'], apply: fn } 对象，确保 Cordis 在 slots 服务 ACTIVE 后才调用 apply。
  registerBuiltinPlugin('@codem/ui-sidebar', { provides: [], inject: ['slots'], slots: ['app.sidebar'], priority: 0 }, () => ({ inject: ['slots'], apply: (ctx: any) => uiSidebarApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-conversation', { provides: [], inject: ['slots'], slots: ['app.conversation'], priority: 0 }, () => ({ inject: ['slots'], apply: (ctx: any) => uiConversationApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-tool', { provides: [], inject: ['slots'], slots: ['conversation.details.tool'], priority: 0 }, () => ({ inject: ['slots'], apply: (ctx: any) => uiToolApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-settings', { provides: [], inject: ['slots'], slots: ['app.settings'], priority: 0 }, () => ({ inject: ['slots'], apply: (ctx: any) => uiSettingsApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-misc', { provides: [], inject: ['slots'], slots: ['app.overlay', 'app.monitor'], priority: 0 }, () => ({ inject: ['slots'], apply: (ctx: any) => uiMiscApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-market', { provides: [], inject: ['slots'], slots: ['app.skill-manager', 'app.mcp-manager', 'app.plugin-manager'], priority: 0 }, () => ({ inject: ['slots'], apply: (ctx: any) => uiMarketApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-theme', { provides: [], inject: [], priority: 0 }, () => ({ apply: (ctx: any) => uiThemeApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-skin-default', { provides: [], inject: [], priority: 0 }, () => ({ apply: (ctx: any) => uiSkinDefaultApply(ctx) }))
  registerBuiltinPlugin('@codem/ui-skin-pet', { provides: [], inject: [], priority: 0 }, () => ({ apply: (ctx: any) => uiSkinPetApply(ctx) }))

  // R5 Providers (从模块级单例升级为 Cordis 服务)
  registerBuiltinPlugin('@codem/cost-tracker', { provides: ['costTracker'], inject: ['llmEngine'], priority: 0, hot: true }, () => costTrackerProvider)
  registerBuiltinPlugin('@codem/model-profile', { provides: ['modelProfile'], inject: ['llmEngine'], priority: 0, hot: true }, () => modelProfileProvider)
  registerBuiltinPlugin('@codem/streaming-executor', { provides: ['streamingExecutor'], inject: [], priority: 0, hot: true }, () => streamingExecutorProvider)
  registerBuiltinPlugin('@codem/tool-render', { provides: ['toolRender'], inject: ['llmEngine'], priority: 0, hot: true }, () => toolRenderProvider)
  registerBuiltinPlugin('@codem/agent-registry', { provides: ['agentRegistry'], inject: ['llmEngine'], priority: 0, hot: true }, () => agentRegistryProvider)
  registerBuiltinPlugin('@codem/recovery', { provides: ['recovery'], inject: ['llmEngine'], priority: 0, hot: true }, () => recoveryProvider)
  registerBuiltinPlugin('@codem/retry', { provides: ['retry'], inject: ['llmEngine'], priority: 0, hot: true }, () => retryProvider)
  registerBuiltinPlugin('@codem/squad-manager', { provides: ['squadManager'], inject: [], priority: 0, hot: true }, () => squadManagerProvider)
  registerBuiltinPlugin('@codem/issue', { provides: ['issue'], inject: [], priority: 0, hot: true }, () => issueProvider)
  registerBuiltinPlugin('@codem/inbox', { provides: ['inbox'], inject: [], priority: 0, hot: true }, () => inboxProvider)

  // R6: Zustand Store Cordis 服务化
  registerBuiltinPlugin('@codem/store', { provides: ['appStore'], inject: [], priority: 0, hot: true }, () => storeProvider)

  // P1-7.4: LLM Provider 插件
  registerBuiltinPlugin('@codem/llm-mimo', { provides: ['llmMimo'], inject: ['llm'], priority: 0, hot: true }, () => llmMimoProvider)
  registerBuiltinPlugin('@codem/llm-openai', { provides: ['llmOpenAI'], inject: ['llm'], priority: 0, hot: true }, () => llmOpenAIProvider)
  registerBuiltinPlugin('@codem/llm-retry', { provides: ['llmRetry'], inject: ['llm', 'llmEngine'], priority: 0, hot: true }, () => llmRetryProvider)
  registerBuiltinPlugin('@codem/token-meter', { provides: ['tokenMeter'], inject: [], priority: 0, hot: true }, () => tokenMeterProvider)

  // P1-7.5: 会话层插件
  registerBuiltinPlugin('@codem/session-persistence-sqlite', { provides: ['sessionPersistence'], inject: ['session'], priority: 0, hot: true }, () => sessionPersistenceSqliteProvider)
  registerBuiltinPlugin('@codem/session-projection', { provides: ['sessionProjection'], inject: ['session'], priority: 0, hot: true }, () => sessionProjectionProvider)
  registerBuiltinPlugin('@codem/session-stats', { provides: ['sessionStats'], inject: ['session'], priority: 0, hot: true }, () => sessionStatsProvider)
  registerBuiltinPlugin('@codem/session-title-llm', { provides: ['sessionTitleLLM'], inject: ['llm', 'session'], priority: 0, hot: true }, () => sessionTitleLLMProvider)
  registerBuiltinPlugin('@codem/session-checkpoint', { provides: ['sessionCheckpoint'], inject: ['session'], priority: 0, hot: true }, () => sessionCheckpointProvider)

  // P1-7.6: Shell/终端插件
  registerBuiltinPlugin('@codem/pwsh-local', { provides: ['pwshLocal'], inject: ['shell'], priority: 0, hot: true }, () => pwshLocalProvider)
  registerBuiltinPlugin('@codem/bash-sandbox', { provides: ['bashSandbox'], inject: ['shell', 'sandbox'], priority: 0, hot: true }, () => bashSandboxProvider)
  registerBuiltinPlugin('@codem/terminal-bash', { provides: ['terminalBash'], inject: ['shell'], priority: 0, hot: true }, () => terminalBashProvider)

  // P1-7.7: 沙箱/安全插件
  registerBuiltinPlugin('@codem/sandbox-policy', { provides: ['sandboxPolicy'], inject: ['sandbox'], priority: 0, hot: true }, () => sandboxPolicyProvider)
  registerBuiltinPlugin('@codem/subprocess', { provides: ['subprocess'], inject: [], priority: 0, hot: true }, () => subprocessProvider)

  // P1-7.8: 子 Agent 插件
  registerBuiltinPlugin('@codem/subagent-fork-in-process', { provides: ['subagentForkInProcess'], inject: ['subagent'], priority: 0, hot: true }, () => subagentForkInProcessProvider)
  registerBuiltinPlugin('@codem/subagent-spawn-in-process', { provides: ['subagentSpawnInProcess'], inject: ['subagent'], priority: 0, hot: true }, () => subagentSpawnInProcessProvider)
  registerBuiltinPlugin('@codem/subagent-control', { provides: ['subagentControl'], inject: ['subagent'], priority: 0, hot: true }, () => toolSubagentControlProvider)

  // P1-7.9: 上下文/压缩插件
  registerBuiltinPlugin('@codem/compaction-basic', { provides: ['compactionBasic'], inject: ['compaction'], priority: 0, hot: true }, () => compactionBasicProvider)
  registerBuiltinPlugin('@codem/compaction-tool-result-pruner', { provides: ['compactionToolResultPruner'], inject: ['compaction'], priority: 0, hot: true }, () => compactionToolResultPrunerProvider)
  registerBuiltinPlugin('@codem/command-compact', { provides: ['commandCompact'], inject: ['compaction', 'commands'], priority: 0, hot: true }, () => commandCompactProvider)

  // P1-7.10: 目标/计划/工作流插件
  registerBuiltinPlugin('@codem/goal-round-driver', { provides: ['goalRoundDriver'], inject: [], priority: 0, hot: true }, () => goalRoundDriverProvider)
  registerBuiltinPlugin('@codem/command-goal', { provides: ['commandGoal'], inject: ['commands'], priority: 0, hot: true }, () => commandGoalProvider)
  registerBuiltinPlugin('@codem/plan-mode', { provides: ['planMode'], inject: ['plans'], priority: 0, hot: true }, () => planModeProvider)

  // P2-7.11: Web/搜索插件
  registerBuiltinPlugin('@codem/web-fetch-http', { provides: ['webFetchHttp'], inject: ['web'], priority: 0, hot: true }, () => webFetchHttpProvider)
  registerBuiltinPlugin('@codem/web-search-mimo', { provides: ['webSearchMimo'], inject: ['web'], priority: 0, hot: true }, () => webSearchMimoProvider)

  // P2-7.12: Guard/保护插件
  registerBuiltinPlugin('@codem/repeat-tool-reminder', { provides: ['repeatToolReminder'], inject: ['guard'], priority: 0, hot: true }, () => repeatToolReminderProvider)
  registerBuiltinPlugin('@codem/timeout-guard', { provides: ['timeoutGuard'], inject: ['guard'], priority: 0, hot: true }, () => timeoutGuardProvider)
  registerBuiltinPlugin('@codem/invariants-guard', { provides: ['invariantsGuard'], inject: ['guard'], priority: 0, hot: true }, () => invariantsGuardProvider)

  // P2-7.13: Host/Client 架构插件
  registerBuiltinPlugin('@codem/host-webserver', { provides: ['hostWebserver'], inject: ['hostClient'], priority: 0, hot: true }, () => hostWebserverProvider)
  registerBuiltinPlugin('@codem/host-plugin-inventory', { provides: ['hostPluginInventory'], inject: ['hostClient'], priority: 0, hot: true }, () => hostPluginInventoryProvider)
  registerBuiltinPlugin('@codem/sdk-protocol', { provides: ['sdkProtocol'], inject: ['hostClient'], priority: 0, hot: true }, () => sdkProtocolProvider)

  // P2-7.14: UI 原语和面板插件
  registerBuiltinPlugin('@codem/ui-primitives', { provides: ['uiPrimitives'], inject: [], priority: 0, hot: true }, () => uiPrimitivesProvider)
  registerBuiltinPlugin('@codem/ui-input-trigger', { provides: ['uiInputTrigger'], inject: [], priority: 0, hot: true }, () => uiInputTriggerProvider)
  registerBuiltinPlugin('@codem/ui-agent-preset', { provides: ['uiAgentPreset'], inject: [], priority: 0, hot: true }, () => uiAgentPresetProvider)
  registerBuiltinPlugin('@codem/ui-skill-panel', { provides: ['uiSkillPanel'], inject: [], priority: 0, hot: true }, () => uiSkillPanelProvider)

  // P2-7.15: Typert 类型系统插件
  registerBuiltinPlugin('@codem/typert-generator', { provides: ['typertGenerator'], inject: [], priority: 0, hot: true }, () => typertGeneratorProvider)
  registerBuiltinPlugin('@codem/typert-loader', { provides: ['typertLoader'], inject: [], priority: 0, hot: true }, () => typertLoaderProvider)
  registerBuiltinPlugin('@codem/typert-protocol', { provides: ['typertProtocol'], inject: [], priority: 0, hot: true }, () => typertProtocolProvider)
  registerBuiltinPlugin('@codem/typert-registry', { provides: ['typertRegistry'], inject: [], priority: 0, hot: true }, () => typertRegistryProvider)

  // R7-1: 缺失 LLM 多模型适配器
  registerBuiltinPlugin('@codem/llm-claude', { provides: ['llmClaude'], inject: ['llm'], priority: 0, hot: true }, () => llmClaudeProvider)
  registerBuiltinPlugin('@codem/llm-gemini', { provides: ['llmGemini'], inject: ['llm'], priority: 0, hot: true }, () => llmGeminiProvider)
  registerBuiltinPlugin('@codem/llm-ollama', { provides: ['llmOllama'], inject: ['llm'], priority: 0, hot: true }, () => llmOllamaProvider)

  // R7-2: 会话恢复插件
  registerBuiltinPlugin('@codem/session-recovery', { provides: ['sessionRecovery'], inject: ['session'], priority: 0, hot: true }, () => sessionRecoveryProvider)

  // R7-3: 缺失 UI 组件插件
  registerBuiltinPlugin('@codem/ui-directory-picker', { provides: ['uiDirectoryPicker'], inject: [], priority: 0, hot: true }, () => uiDirectoryPickerProvider)
  registerBuiltinPlugin('@codem/ui-message-feedback', { provides: ['uiMessageFeedback'], inject: [], priority: 0, hot: true }, () => uiMessageFeedbackProvider)
  registerBuiltinPlugin('@codem/ui-model-selection', { provides: ['uiModelSelection'], inject: ['modelProfile'], priority: 0, hot: true }, () => uiModelSelectionProvider)
  registerBuiltinPlugin('@codem/ui-permission-presets', { provides: ['uiPermissionPresets'], inject: ['permission'], priority: 0, hot: true }, () => uiPermissionPresetsProvider)
  registerBuiltinPlugin('@codem/ui-trajectory', { provides: ['uiTrajectory'], inject: [], priority: 0, hot: true }, () => uiTrajectoryProvider)
  registerBuiltinPlugin('@codem/ui-deliverables', { provides: ['uiDeliverables'], inject: [], priority: 0, hot: true }, () => uiDeliverablesProvider)

  // R7-4: Host/Client 链路拆分
  registerBuiltinPlugin('@codem/bundle', { provides: ['bundle'], inject: [], priority: 0, hot: true }, () => bundleProvider)
  registerBuiltinPlugin('@codem/acp', { provides: ['acp'], inject: ['automation'], priority: 0, hot: true }, () => acpProvider)
  registerBuiltinPlugin('@codem/host', { provides: ['host'], inject: ['hostWebserver'], priority: 0, hot: true }, () => hostProvider)
  registerBuiltinPlugin('@codem/remote-client', { provides: ['client'], inject: ['sdkProtocol'], priority: 0, hot: true }, () => remoteClientProvider)

  // R7-7: CLI 入口插件
  registerBuiltinPlugin('@codem/cli', { provides: ['cli'], inject: ['session', 'tools', 'pluginRegistry'], priority: 0, hot: true }, () => cliProvider)

  // R8: 78 个 DSH 缺失插件补全
  registerBuiltinPlugin('@codem/agent-loop', { provides: ['agentLoop'], inject: ['llm', 'tools', 'agentEngine'], priority: 0, hot: true }, () => agentLoopProvider)
  registerBuiltinPlugin('@codem/agent', { provides: ['agentManager'], inject: ['agentRegistry'], priority: 0, hot: true }, () => agentProvider)
  registerBuiltinPlugin('@codem/agent-default-model', { provides: ['agentDefaultModel'], inject: ['modelProfile'], priority: 0, hot: true }, () => agentDefaultModelProvider)
  registerBuiltinPlugin('@codem/agent-tool-presentation', { provides: ['agentToolPresentation'], inject: ['toolRender'], priority: 0, hot: true }, () => agentToolPresentationProvider)
  registerBuiltinPlugin('@codem/agent-instructions', { provides: ['agentInstructions'], inject: [], priority: 0, hot: true }, () => agentInstructionsProvider)
  registerBuiltinPlugin('@codem/system-prompt', { provides: ['systemPrompt'], inject: ['agentInstructions'], priority: 0, hot: true }, () => systemPromptProvider)
  registerBuiltinPlugin('@codem/scope', { provides: ['scope'], inject: [], priority: 0, hot: true }, () => scopeProvider)
  registerBuiltinPlugin('@codem/session-persistence-jsonl', { provides: ['sessionPersistenceJSONL'], inject: ['session'], priority: 0, hot: true }, () => sessionPersistenceJsonlProvider)
  registerBuiltinPlugin('@codem/session-projection-cache', { provides: ['sessionProjectionCache'], inject: ['sessionProjection'], priority: 0, hot: true }, () => sessionProjectionCacheProvider)
  registerBuiltinPlugin('@codem/session-query-sqlite', { provides: ['sessionQuerySqlite'], inject: ['session'], priority: 0, hot: true }, () => sessionQuerySqliteProvider)
  registerBuiltinPlugin('@codem/session-log-export', { provides: ['sessionLogExport'], inject: ['session'], priority: 0, hot: true }, () => sessionLogExportProvider)
  registerBuiltinPlugin('@codem/session-reference', { provides: ['sessionReference'], inject: ['session'], priority: 0, hot: true }, () => sessionReferenceProvider)
  registerBuiltinPlugin('@codem/session-telemetry-otel', { provides: ['sessionTelemetryOtel'], inject: ['telemetry'], priority: 0, hot: true }, () => sessionTelemetryOtelProvider)
  registerBuiltinPlugin('@codem/session-title-first-prompt-llm', { provides: ['sessionTitleFirstPrompt'], inject: ['llm', 'session'], priority: 0, hot: true }, () => sessionTitleFirstPromptLlmProvider)
  registerBuiltinPlugin('@codem/session-title-all-prompts-llm', { provides: ['sessionTitleAllPrompts'], inject: ['llm', 'session'], priority: 0, hot: true }, () => sessionTitleAllPromptsLlmProvider)
  registerBuiltinPlugin('@codem/session-checkpoint-policy', { provides: ['sessionCheckpointPolicy'], inject: ['sessionCheckpoint'], priority: 0, hot: true }, () => sessionCheckpointPolicyProvider)
  registerBuiltinPlugin('@codem/pwsh-sandbox', { provides: ['pwshSandbox'], inject: ['shell', 'sandbox'], priority: 0, hot: true }, () => pwshSandboxProvider)
  registerBuiltinPlugin('@codem/tool-bash-persistent', { provides: ['toolBashPersistent'], inject: ['shell'], priority: 0, hot: true }, () => toolBashPersistentProvider)
  registerBuiltinPlugin('@codem/tmux-context', { provides: ['tmuxContext'], inject: ['shell'], priority: 0, hot: true }, () => tmuxContextProvider)
  registerBuiltinPlugin('@codem/fs-observation-policy', { provides: ['fsObservationPolicy'], inject: [], priority: 0, hot: true }, () => fsObservationPolicyProvider)
  registerBuiltinPlugin('@codem/fs-sandbox', { provides: ['fsSandbox'], inject: ['fs', 'sandbox'], priority: 0, hot: true }, () => fsSandboxProvider)
  registerBuiltinPlugin('@codem/tool-fs-search', { provides: ['toolFsSearch'], inject: ['fs', 'tools'], priority: 0, hot: true }, () => toolFsSearchProvider)
  registerBuiltinPlugin('@codem/tool-str-replace-editor', { provides: ['toolStrReplaceEditor'], inject: ['fs', 'tools'], priority: 0, hot: true }, () => toolStrReplaceEditorProvider)
  registerBuiltinPlugin('@codem/sandbox-windows-acl', { provides: ['sandboxWindowsAcl'], inject: ['sandbox'], priority: 0, hot: true }, () => sandboxWindowsAclProvider)
  registerBuiltinPlugin('@codem/e2b', { provides: ['e2b'], inject: [], priority: 0, hot: true }, () => e2bProvider)
  registerBuiltinPlugin('@codem/fs-e2b', { provides: ['fsE2b'], inject: ['e2b'], priority: 0, hot: true }, () => fsE2bProvider)
  registerBuiltinPlugin('@codem/subprocess-e2b', { provides: ['subprocessE2b'], inject: ['e2b', 'subprocess'], priority: 0, hot: true }, () => subprocessE2bProvider)
  registerBuiltinPlugin('@codem/subprocess-local', { provides: ['subprocessLocal'], inject: ['subprocess'], priority: 0, hot: true }, () => subprocessLocalProvider)
  registerBuiltinPlugin('@codem/subagent-acp', { provides: ['subagentAcp'], inject: ['subagent', 'acp'], priority: 0, hot: true }, () => subagentAcpProvider)
  registerBuiltinPlugin('@codem/subagent-claude-code', { provides: ['subagentClaudeCode'], inject: ['subagent', 'llm'], priority: 0, hot: true }, () => subagentClaudeCodeProvider)
  registerBuiltinPlugin('@codem/subagent-codex', { provides: ['subagentCodex'], inject: ['subagent', 'llm'], priority: 0, hot: true }, () => subagentCodexProvider)
  registerBuiltinPlugin('@codem/subagent-dsh-sdk', { provides: ['subagentDshSdk'], inject: ['subagent', 'sdkProtocol'], priority: 0, hot: true }, () => subagentDshSdkProvider)
  registerBuiltinPlugin('@codem/subagent-in-process-driver', { provides: ['subagentInProcessDriver'], inject: ['subagent'], priority: 0, hot: true }, () => subagentInProcessDriverProvider)
  registerBuiltinPlugin('@codem/tool-subagent-report', { provides: ['toolSubagentReport'], inject: ['subagent'], priority: 0, hot: true }, () => toolSubagentReportProvider)
  registerBuiltinPlugin('@codem/llm-deepseek', { provides: ['llmDeepseek'], inject: ['llm'], priority: 0, hot: true }, () => llmDeepseekProvider)
  registerBuiltinPlugin('@codem/llm-pi-ai', { provides: ['llmPiAi'], inject: ['llm'], priority: 0, hot: true }, () => llmPiAiProvider)
  registerBuiltinPlugin('@codem/web-search-exa', { provides: ['webSearchExa'], inject: ['web'], priority: 0, hot: true }, () => webSearchExaProvider)
  registerBuiltinPlugin('@codem/web-search-perplexity', { provides: ['webSearchPerplexity'], inject: ['web'], priority: 0, hot: true }, () => webSearchPerplexityProvider)
  registerBuiltinPlugin('@codem/time-context', { provides: ['timeContext'], inject: [], priority: 0, hot: true }, () => timeContextProvider)
  registerBuiltinPlugin('@codem/tool-ralph', { provides: ['toolRalph'], inject: ['workflow', 'tools'], priority: 0, hot: true }, () => toolRalphProvider)
  registerBuiltinPlugin('@codem/workflow-worker-thread', { provides: ['workflowWorkerThread'], inject: ['workflow'], priority: 0, hot: true }, () => workflowWorkerThreadProvider)
  registerBuiltinPlugin('@codem/code-runtime-worker-thread', { provides: ['codeRuntimeWorkerThread'], inject: ['codeRuntime'], priority: 0, hot: true }, () => codeRuntimeWorkerThreadProvider)
  registerBuiltinPlugin('@codem/spill', { provides: ['spill'], inject: [], priority: 0, hot: true }, () => spillProvider)
  registerBuiltinPlugin('@codem/spill-local', { provides: ['spillLocal'], inject: ['spill'], priority: 0, hot: true }, () => spillLocalProvider)
  registerBuiltinPlugin('@codem/spill-policy', { provides: ['spillPolicy'], inject: ['spill'], priority: 0, hot: true }, () => spillPolicyProvider)
  registerBuiltinPlugin('@codem/tool-call-timeout-policy', { provides: ['toolCallTimeoutPolicy'], inject: ['timeoutGuard'], priority: 0, hot: true }, () => toolCallTimeoutPolicyProvider)
  registerBuiltinPlugin('@codem/host-apiproxy', { provides: ['hostApiproxy'], inject: ['hostWebserver'], priority: 0, hot: true }, () => hostApiproxyProvider)
  registerBuiltinPlugin('@codem/host-frontend-static', { provides: ['hostFrontendStatic'], inject: ['hostWebserver'], priority: 0, hot: true }, () => hostFrontendStaticProvider)
  registerBuiltinPlugin('@codem/sdk-client', { provides: ['sdkClient'], inject: ['sdkProtocol'], priority: 0, hot: true }, () => sdkClientProvider)
  registerBuiltinPlugin('@codem/api-gateway', { provides: ['apiGateway'], inject: ['hostWebserver'], priority: 0, hot: true }, () => apiGatewayProvider)
  registerBuiltinPlugin('@codem/api-remotes', { provides: ['apiRemotes'], inject: ['sdkProtocol'], priority: 0, hot: true }, () => apiRemotesProvider)
  registerBuiltinPlugin('@codem/ui-attachment', { provides: ['uiAttachment'], inject: ['slots'], priority: 0, hot: true }, () => uiAttachmentProvider)
  registerBuiltinPlugin('@codem/ui-cordis', { provides: ['uiCordis'], inject: ['slots'], priority: 0, hot: true }, () => uiCordisProvider)
  registerBuiltinPlugin('@codem/ui-goal', { provides: ['uiGoal'], inject: ['slots'], priority: 0, hot: true }, () => uiGoalProvider)
  registerBuiltinPlugin('@codem/ui-jobs', { provides: ['uiJobs'], inject: ['slots'], priority: 0, hot: true }, () => uiJobsProvider)
  registerBuiltinPlugin('@codem/ui-layout', { provides: ['uiLayout'], inject: ['slots'], priority: 0, hot: true }, () => uiLayoutProvider)
  registerBuiltinPlugin('@codem/ui-plan', { provides: ['uiPlan'], inject: ['slots'], priority: 0, hot: true }, () => uiPlanProvider)
  registerBuiltinPlugin('@codem/ui-settings-general', { provides: ['uiSettingsGeneral'], inject: ['slots'], priority: 0, hot: true }, () => uiSettingsGeneralProvider)
  registerBuiltinPlugin('@codem/ui-settings-models', { provides: ['uiSettingsModels'], inject: ['slots'], priority: 0, hot: true }, () => uiSettingsModelsProvider)
  registerBuiltinPlugin('@codem/ui-settings-plugin-inventory', { provides: ['uiSettingsPluginInventory'], inject: ['slots'], priority: 0, hot: true }, () => uiSettingsPluginInventoryProvider)
  registerBuiltinPlugin('@codem/ui-settings-plugins', { provides: ['uiSettingsPlugins'], inject: ['slots'], priority: 0, hot: true }, () => uiSettingsPluginsProvider)
  registerBuiltinPlugin('@codem/ui-slots', { provides: ['uiSlots'], inject: ['slots'], priority: 0, hot: true }, () => uiSlotsProvider)
  registerBuiltinPlugin('@codem/ui-subagent', { provides: ['uiSubagent'], inject: ['slots'], priority: 0, hot: true }, () => uiSubagentProvider)
  registerBuiltinPlugin('@codem/ui-user-questions', { provides: ['uiUserQuestions'], inject: ['slots'], priority: 0, hot: true }, () => uiUserQuestionsProvider)
  registerBuiltinPlugin('@codem/ui-workflow-run', { provides: ['uiWorkflowRun'], inject: ['slots'], priority: 0, hot: true }, () => uiWorkflowRunProvider)
  registerBuiltinPlugin('@codem/ui-workspace', { provides: ['uiWorkspace'], inject: ['slots'], priority: 0, hot: true }, () => uiWorkspaceProvider)
  registerBuiltinPlugin('@codem/ui-game', { provides: ['uiGame'], inject: ['slots'], priority: 0, hot: true }, () => uiGameProvider)
  registerBuiltinPlugin('@codem/lsp-stdio', { provides: ['lspStdio'], inject: ['lsp'], priority: 0, hot: true }, () => lspStdioProvider)
  registerBuiltinPlugin('@codem/atomic-write', { provides: ['atomicWrite'], inject: ['fs'], priority: 0, hot: true }, () => atomicWriteProvider)
  registerBuiltinPlugin('@codem/user-approval', { provides: ['userApproval'], inject: ['approval'], priority: 0, hot: true }, () => userApprovalProvider)
  registerBuiltinPlugin('@codem/skill-badge', { provides: ['skillBadge'], inject: ['skill'], priority: 0, hot: true }, () => skillBadgeProvider)
  registerBuiltinPlugin('@codem/skill-filesystem', { provides: ['skillFilesystem'], inject: ['skill', 'fs'], priority: 0, hot: true }, () => skillFilesystemProvider)
  registerBuiltinPlugin('@codem/persona', { provides: ['persona'], inject: [], priority: 0, hot: true }, () => personaProvider)
  registerBuiltinPlugin('@codem/command-feedback', { provides: ['commandFeedback'], inject: [], priority: 0, hot: true }, () => commandFeedbackProvider)
  registerBuiltinPlugin('@codem/cordis-client-runner', { provides: ['cordisClientRunner'], inject: ['sdkClient'], priority: 0, hot: true }, () => cordisClientRunnerProvider)
  registerBuiltinPlugin('@codem/cordis-host-runner', { provides: ['cordisHostRunner'], inject: ['host'], priority: 0, hot: true }, () => cordisHostRunnerProvider)
  registerBuiltinPlugin('@codem/tool-jobs', { provides: ['toolJobs'], inject: ['tools', 'automation'], priority: 0, hot: true }, () => toolJobsProvider)
  registerBuiltinPlugin('@codem/storage-domain', { provides: ['storageDomain'], inject: ['storage'], priority: 0, hot: true }, () => storageDomainProvider)
  registerBuiltinPlugin('@codem/storage-json', { provides: ['storageJson'], inject: ['storage'], priority: 0, hot: true }, () => storageJsonProvider)

  console.log(`[PluginRegistry] Registered ${builtinPluginCount()} builtin plugins`)
}

function builtinPluginCount(): number {
  return getBuiltinPluginCount()
}
