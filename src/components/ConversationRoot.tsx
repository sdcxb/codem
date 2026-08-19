/**
 * ConversationRoot — 会话区域根组件
 *
 * 对标 DSH 的 ConversationRoot 组件。
 * 作为 app.conversation slot 的默认实现，内部声明子 slot 层级：
 *
 * conversation (ConversationRoot)
 *   ├── conversation.session (消息内容区)
 *   │   └── conversation.session.header.actions (list — JobsBadge 等)
 *   └── conversation.composer (输入区)
 *       └── conversation.composer.bar (ModelSelect, PlanChip, PermissionPreset)
 *
 * 当子 slot 有注册的组件时使用插件组件，
 * 否则 fallback 到现有的 ChatPanel（功能零退化）。
 */

import { memo } from 'react'
import { SlotBridge } from '../core/slots/SlotBridge'
import { ChatPanel } from './ChatPanel'
import type { MessageAttachment } from '../store'
import type { CollaborationMode } from '../core/agent/agent'

export interface ConversationRootProps {
  onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void
  onCancel: () => void
  onSendGuidance?: (message: string) => void
  onToggleSidebar: () => void
  onFork?: (messageIndex: number) => void
  onRegenerate?: (messageIndex: number) => void
  onEditAndResend?: (messageId: string, newContent: string) => void
  onReEdit?: (content: string) => void
  sessionId?: string
  connected: boolean
  model: string
  onModelChange: (model: string) => void
  mode?: "cli" | "api"
  providerId?: string
  collaborationMode?: CollaborationMode
  onModeChange?: (mode: CollaborationMode) => void
  projectPath?: string
  currentSessionId?: string
  onCitationClick?: (sourceName: string) => void
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void
  notebookId?: string
}

/**
 * 会话区域根组件。
 * 使用 SlotBridge 消费 conversation.session 和 conversation.composer 子 slot。
 * 当子 slot 无注册组件时，fallback 到 ChatPanel（功能零退化）。
 */
export const ConversationRoot = memo(function ConversationRoot(props: ConversationRootProps) {
  // 消费 conversation.session 子 slot — 允许插件替换会话内容区
  // fallback 到 ChatPanel 保持功能零退化
  return (
    <SlotBridge
      name="conversation.session"
      fallback={ChatPanel}
      {...props}
    />
  )
})
