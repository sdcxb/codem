// @ts-nocheck
/**
 * @codem/ui-tool — 工具调用展示 UI 插件包
 *
 * 将 ToolCallCard/ToolCallGroup 组件注册到 Slot Registry。
 * conversation.details.tool slot 现在在 ChatPanel 中通过 SlotBridge 消费。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const ToolCallCard = lazy(() => import('../../../components/ToolCallCard'))
const ToolCallGroup = lazy(() => import('../../../components/ToolCallGroup'))

export function apply() {
  const ctx = useCtx()
  const slots = ctx.get('slots')

  // conversation.details.tool slot — 在 ChatPanel 中通过 SlotBridge 消费
  slots.register({ name: 'conversation.details.tool', id: 'default-tool-group', priority: 0 }, ToolCallGroup)
}
