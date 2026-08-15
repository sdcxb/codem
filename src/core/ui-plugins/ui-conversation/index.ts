// @ts-nocheck
/**
 * @codem/ui-conversation — 会话 UI 插件包
 *
 * 将 ChatPanel/MessageBubble/InputArea 组件注册到 Slot Registry。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const ChatPanel = lazy(() => import('../../../components/ChatPanel'))
const MessageBubble = lazy(() => import('../../../components/MessageBubble'))
const InputArea = lazy(() => import('../../../components/InputArea'))
const ToolCallCard = lazy(() => import('../../../components/ToolCallCard'))

export function apply() {
  const ctx = useCtx()

  ctx.slots.register('app.conversation', ChatPanel)
  ctx.slots.register('conversation.messages', MessageBubble)
  ctx.slots.register('conversation.input', InputArea)
  ctx.slots.register('conversation.node.tool', ToolCallCard)
}
