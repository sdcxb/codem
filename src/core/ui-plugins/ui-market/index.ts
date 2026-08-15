// @ts-nocheck
/**
 * @codem/ui-market — 插件市场 UI 插件包
 *
 * 将 SkillManager/McpManager 注册到 Slot Registry。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const SkillManager = lazy(() => import('../../../components/SkillManager'))
const McpManager = lazy(() => import('../../../components/McpManager'))
const McpMarketplace = lazy(() => import('../../../components/McpMarketplace'))

export function apply() {
  const ctx = useCtx()

  ctx.slots.register('app.market', SkillManager)
  ctx.slots.register('app.market', McpMarketplace)

  console.log('[ui-market] Registered market UI plugins')
}
