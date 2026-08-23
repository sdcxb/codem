/**
 * ConversationRoot — 会话区域根组件
 *
 * 对标 DSH 的 ConversationRoot 组件。
 * 作为 app.conversation slot 的默认实现。
 *
 * DSH 的设计：根组件直接渲染内容，不用 lazy/Suspense。
 * 子 slot（conversation.session 等）通过 renderSlot API 消费，
 * 当前阶段直接渲染 ChatPanel（功能零退化），后续迁移到 renderSlot。
 */

import { memo } from 'react'
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
 * 直接渲染 ChatPanel — 同步导入，不经过 lazy/Suspense。
 */
export const ConversationRoot = memo(function ConversationRoot(props: ConversationRootProps) {
  return <ChatPanel {...props} />
})
