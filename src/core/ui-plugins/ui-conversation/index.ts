// @ts-nocheck
/**
 * @codem/ui-conversation — 会话 UI 插件包
 *
 * 对标 DSH packages/client/ui-conversation。
 * 将 ConversationRoot/ChatPanel/MessageBubble/InputArea 组件注册到 Slot Registry。
 *
 * ConversationRoot 作为 app.conversation slot 的默认实现，
 * 内部声明子 slot 层级（conversation.session, conversation.composer 等）。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const ConversationRoot = lazy(() => import('../../../components/ConversationRoot'))
const ChatPanel = lazy(() => import('../../../components/ChatPanel'))
const MessageBubble = lazy(() => import('../../../components/MessageBubble'))
const InputArea = lazy(() => import('../../../components/InputArea'))
const ToolCallCard = lazy(() => import('../../../components/ToolCallCard'))

export function apply() {
  const ctx = useCtx()
  const slots = ctx.get('slots')

  // 注册 ConversationRoot 到 app.conversation slot，并声明子 slot 层级
  // 对标 DSH 的 conversation slot 层级
  slots.register({
    name: 'app.conversation',
    id: 'default-conversation-root',
    priority: 0,
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.composer.bar': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
    },
  }, ConversationRoot)

  // 保留 ChatPanel 作为兼容回退
  slots.register({ name: 'app.conversation', id: 'legacy-chat-panel', priority: -1 }, ChatPanel)

  // 注册消息组件到 conversation.messages slot
  slots.register({ name: 'conversation.messages', id: 'default-messages', priority: 0 }, MessageBubble)

  // 注册输入区组件到 conversation.input slot
  slots.register({ name: 'conversation.input', id: 'default-input', priority: 0 }, InputArea)

  // 注册工具调用卡片到 conversation.node.tool slot
  slots.register({ name: 'conversation.node.tool', id: 'default-tool-card', priority: 0 }, ToolCallCard)
}
