// @ts-nocheck
/**
 * @codem/ui-panels — 面板/对话框 UI 插件包
 *
 * 将所有剩余的 App 级别面板和对话框组件注册到 Slot Registry。
 * 每个组件通过 lazy import 延迟加载，降低首屏开销。
 */
import { lazy } from 'react'

// 布局组件
const TitleBar = lazy(() => import('../../../components/TitleBar'))
const BootSplash = lazy(() => import('../../../components/BootSplash'))
const WorkspaceBackdrop = lazy(() => import('../../../components/WorkspaceBackdrop'))
const ToastContainer = lazy(() => import('../../../components/ToastNotification'))
const TerminalPanel = lazy(() => import('../../../components/TerminalPanel'))
const FileExplorer = lazy(() => import('../../../components/FileExplorer'))
const FileEditor = lazy(() => import('../../../components/FileEditor'))
const RightSidebar = lazy(() => import('../../../components/RightSidebar'))
const Drawer = lazy(() => import('../../../components/Drawer'))

// 模态对话框
const ProjectManager = lazy(() => import('../../../components/ProjectManager'))
const ConfigEditor = lazy(() => import('../../../components/ConfigEditor'))
const BootstrapWizard = lazy(() => import('../../../components/BootstrapWizard'))
const PermissionDialog = lazy(() => import('../../../components/PermissionDialog'))
const DecisionTray = lazy(() => import('../../../components/DecisionTray'))
const ConfirmDialog = lazy(() => import('../../../components/ConfirmDialog'))
const CloseConfirmDialog = lazy(() => import('../../../components/CloseConfirmDialog'))
const NeedsYouPanel = lazy(() => import('../../../components/NeedsYouPanel'))

// 管理器面板
const SessionRecovery = lazy(() => import('../../../components/SessionRecovery'))
const NotebookManager = lazy(() => import('../../../components/NotebookManager'))
const NotebookWorkspace = lazy(() => import('../../../components/NotebookWorkspace'))
const UsageStats = lazy(() => import('../../../components/UsageStats'))
const TaskCenter = lazy(() => import('../../../components/TaskCenter'))
const AgentManager = lazy(() => import('../../../components/AgentManager'))
const ModelProfilePanel = lazy(() => import('../../../components/ModelProfilePanel'))
const MemoryManager = lazy(() => import('../../../components/MemoryManager'))

// 扩展面板
const SourceViewer = lazy(() => import('../../../components/SourceViewer'))
const GitHubCloneDialog = lazy(() => import('../../../components/GitHubCloneDialog'))
const CiCdPanel = lazy(() => import('../../../components/CiCdPanel'))
const DiffViewer = lazy(() => import('../../../components/DiffViewer'))
const InlineDiffReview = lazy(() => import('../../../components/InlineDiffReview'))
const InteractiveFormDialog = lazy(() => import('../../../components/InteractiveFormDialog'))
const PromptChangeReviewDialog = lazy(() => import('../../../components/PromptChangeReviewDialog'))
const PlanApprovalCard = lazy(() => import('../../../components/PlanApprovalCard'))
const OnboardingTour = lazy(() => import('../../../components/OnboardingTour'))
const QuickAccessCards = lazy(() => import('../../../components/QuickAccessCards'))
const CorrectionResultPanel = lazy(() => import('../../../components/CorrectionResultPanel'))
const ClarificationForm = lazy(() => import('../../../components/ClarificationForm'))
const PipelineNextStepDialog = lazy(() => import('../../../components/PipelineNextStepDialog'))

// 能力监控面板 — 对标 DSH ui-* 插件包
// 情况 A: 命名不一致 — 组件已存在但名字不同
const MessageFeedback = lazy(() => import('../../../components/FeedbackButtons')) // DSH ui-message-feedback
const PluginMarket = lazy(() => import('../../../components/PluginManager')) // DSH 无对应 (已有 ui-market/plugin-market.tsx)
const SettingsGeneral = lazy(() => import('../../../components/SettingsPanel')) // DSH ui-settings-general
const SettingsModels = lazy(() => import('../../../components/ModelProfilePanel')) // DSH ui-settings-models
const SettingsPlugins = lazy(() => import('../../../components/SettingsPanel')) // DSH ui-settings-plugins
const UICommands = lazy(() => import('../../../components/SlashCommandMenu')) // DSH ui-commands

// 情况 B: 功能嵌入其他组件 — 已提取为独立组件注册到 Slot
const PlanModeChip = lazy(() => import('../../../components/PlanModeChip')) // DSH ui-plan (composer chip)
const ModelSelector = lazy(() => import('../../../components/ModelSelector')) // DSH ui-model-selection (composer dropdown)
const PermissionPresetSelector = lazy(() => import('../../../components/PermissionPresetSelector')) // DSH ui-permission-presets
const DeliverableFiles = lazy(() => import('../../../components/DeliverableFiles')) // DSH ui-deliverables (turn-tail)

// 情况 C: 功能尚未实现 — 已对标 DSH 创建独立组件
const JobsBadge = lazy(() => import('../../../components/JobsBadge')) // DSH ui-jobs (会话头部任务列表)
const TrajectoryPanel = lazy(() => import('../../../components/TrajectoryPanel')) // DSH ui-trajectory (对话轨迹详情)

export function apply(ctx: any) {
  const slots = ctx.get('slots')

  // 布局组件
  slots.register({ name: 'app.titlebar', id: 'default-titlebar', priority: 0 }, TitleBar)
  slots.register({ name: 'app.boot-splash', id: 'default-boot-splash', priority: 0 }, BootSplash)
  slots.register({ name: 'app.workspace-backdrop', id: 'default-workspace-backdrop', priority: 0 }, WorkspaceBackdrop)
  slots.register({ name: 'app.toast-container', id: 'default-toast', priority: 0 }, ToastContainer)
  slots.register({ name: 'app.terminal', id: 'default-terminal', priority: 0 }, TerminalPanel)
  // app.file-explorer / app.file-editor / app.diff-viewer slot 注册已移除
  // 这些组件在 RightSidebar 中直接使用，没有独立消费点


  // 模态对话框
  slots.register({ name: 'app.project-manager', id: 'default-project-mgr', priority: 0 }, ProjectManager)
  slots.register({ name: 'app.config-editor', id: 'default-config-editor', priority: 0 }, ConfigEditor)
  slots.register({ name: 'app.bootstrap-wizard', id: 'default-bootstrap-wizard', priority: 0 }, BootstrapWizard)
  slots.register({ name: 'app.permission-dialog', id: 'default-permission-dialog', priority: 0 }, PermissionDialog)
  slots.register({ name: 'app.decision-tray', id: 'default-decision-tray', priority: 0 }, DecisionTray)
  slots.register({ name: 'app.confirm-dialog', id: 'default-confirm-dialog', priority: 0 }, ConfirmDialog)
  slots.register({ name: 'app.close-confirm-dialog', id: 'default-close-confirm', priority: 0 }, CloseConfirmDialog)
  slots.register({ name: 'app.needs-you-panel', id: 'default-needs-you', priority: 0 }, NeedsYouPanel)

  // 管理器面板
  slots.register({ name: 'app.session-recovery', id: 'default-session-recovery', priority: 0 }, SessionRecovery)
  slots.register({ name: 'app.notebook-manager', id: 'default-notebook-mgr', priority: 0 }, NotebookManager)
  slots.register({ name: 'app.notebook-workspace', id: 'default-notebook-workspace', priority: 0 }, NotebookWorkspace)
  slots.register({ name: 'app.usage-stats', id: 'default-usage-stats', priority: 0 }, UsageStats)
  slots.register({ name: 'app.task-center', id: 'default-task-center', priority: 0 }, TaskCenter)
  slots.register({ name: 'app.agent-manager', id: 'default-agent-mgr', priority: 0 }, AgentManager)
  slots.register({ name: 'app.memory-manager', id: 'default-memory-mgr', priority: 0 }, MemoryManager)

  // 扩展面板
  slots.register({ name: 'app.source-viewer', id: 'default-source-viewer', priority: 0 }, SourceViewer)
  slots.register({ name: 'app.github-clone-dialog', id: 'default-github-clone', priority: 0 }, GitHubCloneDialog)
  slots.register({ name: 'app.cicd-panel', id: 'default-cicd', priority: 0 }, CiCdPanel)
  // app.diff-viewer slot 注册已移除 — DiffViewer 在 RightSidebar 中直接使用，无独立消费点
  slots.register({ name: 'app.inline-diff-review', id: 'default-inline-diff', priority: 0 }, InlineDiffReview)
  slots.register({ name: 'app.interactive-form-dialog', id: 'default-interactive-form', priority: 0 }, InteractiveFormDialog)
  slots.register({ name: 'app.prompt-change-review-dialog', id: 'default-prompt-change-review', priority: 0 }, PromptChangeReviewDialog)
  slots.register({ name: 'app.plan-approval-card', id: 'default-plan-approval', priority: 0 }, PlanApprovalCard)
  slots.register({ name: 'app.onboarding-tour', id: 'default-onboarding', priority: 0 }, OnboardingTour)
  slots.register({ name: 'app.quick-access-cards', id: 'default-quick-access', priority: 0 }, QuickAccessCards)
  slots.register({ name: 'app.correction-result-panel', id: 'default-correction-result', priority: 0 }, CorrectionResultPanel)
  slots.register({ name: 'app.clarification-form', id: 'default-clarification', priority: 0 }, ClarificationForm)
  slots.register({ name: 'app.pipeline-next-step-dialog', id: 'default-pipeline-next-step', priority: 0 }, PipelineNextStepDialog)

  // 能力监控面板 — 注册存在的组件到 slot
  // 注意: ToolPanel 已由 ui-tool/index.ts 注册到 conversation.details.tool slot
  //       WorkspacePanel 已注册到 app.file-explorer slot
  //       MessageFeedback 功能已由 FeedbackButtons 在 ChatPanel 中内联渲染
  //       PlanApprovalCard 已注册到 app.plan-approval-card slot
  //       InlineDiffReview 已注册到 app.inline-diff-review slot (含 Deliverables 功能)
  // 这里注册的是独立 slot，供 App.tsx SlotBridge 消费
  slots.register({ name: 'app.message-feedback', id: 'default-message-feedback', priority: 0 }, MessageFeedback)
  slots.register({ name: 'app.ui-commands', id: 'default-ui-commands', priority: 0 }, UICommands)

  // R8 UI 插件新增 Slot — 注册低优先级默认 fallback 组件
  // 当 R8 Provider 关闭时，这些默认组件仍然可用
  slots.register({ name: 'app.subagent', id: 'default-subagent', priority: 0 },
    lazy(() => import('../../../components/DelegationPanel')))
  slots.register({ name: 'app.user-questions', id: 'default-user-questions', priority: 0 },
    lazy(() => import('../../../components/InteractiveFormDialog')))
  slots.register({ name: 'app.workflow-run', id: 'default-workflow-run', priority: 0 },
    lazy(() => import('../../../components/ActivityTimeline')))
  slots.register({ name: 'app.attachment', id: 'default-attachment', priority: 0 },
    lazy(() => import('../../../components/FileUpload')))

  // B类: 从嵌入组件提取的独立组件
  slots.register({ name: 'app.plan-mode-chip', id: 'default-plan-mode-chip', priority: 0 }, PlanModeChip)
  slots.register({ name: 'app.model-selector', id: 'default-model-selector', priority: 0 }, ModelSelector)
  slots.register({ name: 'app.permission-preset-selector', id: 'default-permission-preset', priority: 0 }, PermissionPresetSelector)
  slots.register({ name: 'app.deliverable-files', id: 'default-deliverable-files', priority: 0 }, DeliverableFiles)

  // C类: 对标 DSH 创建的独立组件
  slots.register({ name: 'app.jobs-badge', id: 'default-jobs-badge', priority: 0 }, JobsBadge)
  slots.register({ name: 'app.trajectory-panel', id: 'default-trajectory-panel', priority: 0 }, TrajectoryPanel)

  // app.plugin-market slot 注册已移除 — PluginManager 已注册到 app.plugin-manager slot

// 设置子面板注册已移除 — SettingsPanel 已通过 app.settings slot 消费，内部 tab 逻辑不需要额外 slot

  // sidebar tabs (list type — 多插件可贡献)
  // TODO: 对标 DSH ui-sidebar 创建 FilesTab/SearchTab/MemoryTab 组件
  // slots.register({ name: 'sidebar.tabs', id: 'default-sidebar-tab-files', priority: 0, order: 0 },
  //   lazy(() => import('../../../components/sidebar/FilesTab')))
  // slots.register({ name: 'sidebar.tabs', id: 'default-sidebar-tab-search', priority: 0, order: 10 },
  //   lazy(() => import('../../../components/sidebar/SearchTab')))
  // slots.register({ name: 'sidebar.tabs', id: 'default-sidebar-tab-memory', priority: 0, order: 20 },
  //   lazy(() => import('../../../components/sidebar/MemoryTab')))

  // bottom panel tabs (list type)
  // TODO: 对标 DSH 创建 TerminalTab 组件
  // slots.register({ name: 'bottom-panel.tabs', id: 'default-bottom-tab-terminal', priority: 0, order: 0 },
  //   lazy(() => import('../../../components/bottom-panel/TerminalTab')))

  console.log('[ui-panels] Registered all panel/dialog UI plugins')
}
