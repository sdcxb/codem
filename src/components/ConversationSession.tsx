/**
 * ConversationSession — 会话内容区
 *
 * 对标 DSH 的 ConversationSession 组件。
 * 包含消息列表、会话头部（含 conversation.session.header.actions slot）等。
 * 消费 conversation.session.header.actions 子 slot（list 类型）。
 */

import { memo } from 'react'
import { SlotListBridge } from '../core/slots/SlotBridge'
import { ChatPanel } from './ChatPanel'
import type { MessageAttachment } from '../store'
import type { CollaborationMode } from '../core/agent/agent'

export interface ConversationSessionProps {
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
 * 会话内容区组件。
 * 消费 conversation.session.header.actions 子 slot（JobsBadge 等）。
 * fallback 到 ChatPanel 保持功能零退化。
 */
export const ConversationSession = memo(function ConversationSession(props: ConversationSessionProps) {
  return (
    <>
      {/* SlotListBridge 消费 conversation.session.header.actions — list 类型 slot */}
      <SlotListBridge name="conversation.session.header.actions" />
      <ChatPanel {...props} />
    </>
  )
})
