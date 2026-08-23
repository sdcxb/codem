// @ts-nocheck
/**
 * @codem/ui-panels — 面板/对话框 UI 插件包
 *
 * 对标 DSH：组件同步导入，不用 React.lazy。
 * 所有组件直接 import，slot.register() 传入组件本身。
 */

// 布局组件
import { TitleBar } from '../../../components/TitleBar'
import { BootSplash } from '../../../components/BootSplash'
import { WorkspaceBackdrop } from '../../../components/WorkspaceBackdrop'
import { ToastContainer } from '../../../components/ToastNotification'
import { TerminalPanel } from '../../../components/TerminalPanel'
import { FileExplorer } from '../../../components/FileExplorer'
import { FileEditor } from '../../../components/FileEditor'
import { RightSidebar } from '../../../components/RightSidebar'
import { Drawer } from '../../../components/Drawer'

// 模态对话框
import { ProjectManager } from '../../../components/ProjectManager'
import { ConfigEditor } from '../../../components/ConfigEditor'
import { BootstrapWizard } from '../../../components/BootstrapWizard'
import { PermissionDialog } from '../../../components/PermissionDialog'
import { DecisionTray } from '../../../components/DecisionTray'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { CloseConfirmDialog } from '../../../components/CloseConfirmDialog'
import { NeedsYouPanel } from '../../../components/NeedsYouPanel'

// 管理器面板
import { SessionRecovery } from '../../../components/SessionRecovery'
import { NotebookManager } from '../../../components/NotebookManager'
import { NotebookWorkspace } from '../../../components/NotebookWorkspace'
import { UsageStats } from '../../../components/UsageStats'
import { TaskCenter } from '../../../components/TaskCenter'
import { AgentManager } from '../../../components/AgentManager'
import { ModelProfilePanel } from '../../../components/ModelProfilePanel'
import { MemoryManager } from '../../../components/MemoryManager'

// 扩展面板
import { SourceViewer } from '../../../components/SourceViewer'
import { GitHubCloneDialog } from '../../../components/GitHubCloneDialog'
import { CicdPanel } from '../../../components/CicdPanel'
import { DiffViewer } from '../../../components/DiffViewer'
import { InlineDiffReview } from '../../../components/InlineDiffReview'
import { InteractiveFormDialog } from '../../../components/InteractiveFormDialog'
import { PromptChangeReviewDialog } from '../../../components/PromptChangeReviewDialog'
import { PlanApprovalCard } from '../../../components/PlanApprovalCard'
import { OnboardingTour } from '../../../components/OnboardingTour'
import { QuickAccessCards } from '../../../components/QuickAccessCards'
import { CorrectionResultPanel } from '../../../components/CorrectionResultPanel'
import { ClarificationForm } from '../../../components/ClarificationForm'
import { PipelineNextStepDialog } from '../../../components/PipelineNextStepDialog'

// 能力监控面板
import { FeedbackButtons as MessageFeedback } from '../../../components/FeedbackButtons'
import { SlashCommandMenu as UICommands } from '../../../components/SlashCommandMenu'

// B类: 从嵌入组件提取的独立组件
import { PlanModeChip } from '../../../components/PlanModeChip'
import { ModelSelector } from '../../../components/ModelSelector'
import { PermissionPresetSelector } from '../../../components/PermissionPresetSelector'
import { DeliverableFiles } from '../../../components/DeliverableFiles'

// C类: 对标 DSH 创建的独立组件
import { JobsBadge } from '../../../components/JobsBadge'
import { TrajectoryPanel } from '../../../components/TrajectoryPanel'

// R8 默认 fallback 组件
import { FileUpload } from '../../../components/FileUpload'

export function apply(ctx: any) {
  const slots = ctx.get('slots')

  // 布局组件
  slots.register({ name: 'app.titlebar', id: 'default-titlebar', priority: 0 }, TitleBar)
  slots.register({ name: 'app.boot-splash', id: 'default-boot-splash', priority: 0 }, BootSplash)
  slots.register({ name: 'app.workspace-backdrop', id: 'default-workspace-backdrop', priority: 0 }, WorkspaceBackdrop)
  slots.register({ name: 'app.toast-container', id: 'default-toast', priority: 0 }, ToastContainer)
  slots.register({ name: 'app.terminal', id: 'default-terminal', priority: 0 }, TerminalPanel)

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
  slots.register({ name: 'app.cicd-panel', id: 'default-cicd', priority: 0 }, CicdPanel)
  slots.register({ name: 'app.inline-diff-review', id: 'default-inline-diff', priority: 0 }, InlineDiffReview)
  slots.register({ name: 'app.interactive-form-dialog', id: 'default-interactive-form', priority: 0 }, InteractiveFormDialog)
  slots.register({ name: 'app.prompt-change-review-dialog', id: 'default-prompt-change-review', priority: 0 }, PromptChangeReviewDialog)
  slots.register({ name: 'app.plan-approval-card', id: 'default-plan-approval', priority: 0 }, PlanApprovalCard)
  slots.register({ name: 'app.onboarding-tour', id: 'default-onboarding', priority: 0 }, OnboardingTour)
  slots.register({ name: 'app.quick-access-cards', id: 'default-quick-access', priority: 0 }, QuickAccessCards)
  slots.register({ name: 'app.correction-result-panel', id: 'default-correction-result', priority: 0 }, CorrectionResultPanel)
  slots.register({ name: 'app.clarification-form', id: 'default-clarification', priority: 0 }, ClarificationForm)
  slots.register({ name: 'app.pipeline-next-step-dialog', id: 'default-pipeline-next-step', priority: 0 }, PipelineNextStepDialog)

  // 能力监控面板
  slots.register({ name: 'app.message-feedback', id: 'default-message-feedback', priority: 0 }, MessageFeedback)
  slots.register({ name: 'app.ui-commands', id: 'default-ui-commands', priority: 0 }, UICommands)

  // R8 UI 插件新增 Slot — 注册低优先级默认 fallback 组件
  // 注意：app.user-questions、app.workflow-run、app.subagent 不在此注册
  // 因为这些 slot 在 App.tsx 中以无 props 方式消费，
  // 而 InteractiveFormDialog/ActivityTimeline/DelegationPanel 都需要特定 props，
  // 注册后会导致崩溃或意外弹出模态框。
  slots.register({ name: 'app.attachment', id: 'default-attachment', priority: 0 }, FileUpload)

  // B类: 从嵌入组件提取的独立组件
  slots.register({ name: 'app.plan-mode-chip', id: 'default-plan-mode-chip', priority: 0 }, PlanModeChip)
  slots.register({ name: 'app.model-selector', id: 'default-model-selector', priority: 0 }, ModelSelector)
  slots.register({ name: 'app.permission-preset-selector', id: 'default-permission-preset', priority: 0 }, PermissionPresetSelector)
  slots.register({ name: 'app.deliverable-files', id: 'default-deliverable-files', priority: 0 }, DeliverableFiles)

  // C类: 对标 DSH 创建的独立组件
  slots.register({ name: 'app.jobs-badge', id: 'default-jobs-badge', priority: 0 }, JobsBadge)
  slots.register({ name: 'app.trajectory-panel', id: 'default-trajectory-panel', priority: 0 }, TrajectoryPanel)

  console.log('[ui-panels] Registered all panel/dialog UI plugins')
}
