// @ts-nocheck
/**
 * @codem/ui-conversation — 会话 UI 插件包
 *
 * 对标 DSH packages/client/ui-conversation。
 * 只注册 ConversationRoot 到 app.conversation slot。
 *
 * MessageBubble、InputArea、ToolCallCard 等是 ChatPanel 的内部组件，
 * 由 ChatPanel 直接渲染，不经过 slot 系统（对标 DSH：消息渲染在组件内部完成）。
 */
import { ConversationRoot } from '../../../components/ConversationRoot'
import { ChatPanel } from '../../../components/ChatPanel'

export function apply(ctx: any) {
  const slots = ctx.get('slots')

  // 注册 ConversationRoot 到 app.conversation slot，并声明子 slot 层级
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
}
