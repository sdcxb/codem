// @ts-nocheck
/**
 * @codem/ui-tool — 工具调用展示 UI 插件包
 *
 * 将 ToolCallCard/ToolCallGroup 组件注册到 Slot Registry。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const ToolCallCard = lazy(() => import('../../../components/ToolCallCard'))
const ToolCallGroup = lazy(() => import('../../../components/ToolCallGroup'))

export function apply() {
  const ctx = useCtx()

  ctx.slots.register('conversation.node.tool', ToolCallCard)
  ctx.slots.register('conversation.details.tool', ToolCallGroup)
}
