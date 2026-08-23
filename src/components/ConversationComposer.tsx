/**
 * ConversationComposer — 输入栏区
 *
 * 对标 DSH 的 ConversationComposer 组件。
 * 包含 InputArea 和底部控制栏（模型选择、计划模式、权限预设等）。
 * 消费 conversation.composer.bar 子 slot（list 类型）。
 *
 * 渐进式改造：当前阶段作为 InputArea 的轻量包装，
 * 后续将完整拆分底部控制栏逻辑。
 */

import { memo } from 'react'
import { SlotListBridge } from '../core/slots/SlotBridge'
import { InputArea } from './InputArea'
import type { MessageAttachment } from '../store'
import type { CollaborationMode } from '../core/agent/agent'

export interface ConversationComposerProps {
  onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void
  onCancel: () => void
  disabled: boolean
  isStreaming: boolean
  noSession?: boolean
  /** Session ID — when this changes, internal state (attachments, skills, draft) is reset */
  sessionKey?: string
  collaborationMode: CollaborationMode
  onModeChange: (mode: CollaborationMode) => void
  projectPath?: string
  quoteContext?: string | null
  onClearQuote?: () => void
  notebookId?: string
  model: string
  onModelChange: (model: string) => void
  mode?: "cli" | "api"
  connected?: boolean
}

/**
 * 输入栏区组件。
 * 包含 InputArea 和底部控制栏。
 * 消费 conversation.composer.bar 子 slot（ModelSelect, PlanChip, PermissionPreset 等）。
 * 消费 conversation.composer.dock 子 slot（GoalDock 等）。
 */
export const ConversationComposer = memo(function ConversationComposer(props: ConversationComposerProps) {
  return (
    <>
      {/* SlotListBridge 消费 conversation.composer.bar — list 类型 slot（ModelSelect, PlanChip, PermissionPreset 等） */}
      <SlotListBridge name="conversation.composer.bar" />
      {/* SlotListBridge 消费 conversation.composer.dock — list 类型 slot（GoalDock 等） */}
      <SlotListBridge name="conversation.composer.dock" />
      <InputArea {...props} />
    </>
  )
})
