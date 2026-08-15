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

  ctx.slots.register({ name: 'app.conversation', id: 'default-chat', priority: 0 }, ChatPanel)
  ctx.slots.register({ name: 'conversation.messages', id: 'default-messages', priority: 0 }, MessageBubble)
  ctx.slots.register({ name: 'conversation.input', id: 'default-input', priority: 0 }, InputArea)
  ctx.slots.register({ name: 'conversation.node.tool', id: 'default-tool-card', priority: 0 }, ToolCallCard)
}
