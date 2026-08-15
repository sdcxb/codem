// @ts-nocheck
/**
 * @codem/ui-market — 插件市场 UI 插件包
 *
 * 将 SkillManager/McpManager/PluginManager 注册到 Slot Registry。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

const SkillManager = lazy(() => import('../../../components/SkillManager'))
const McpManager = lazy(() => import('../../../components/McpManager'))
const PluginManager = lazy(() => import('../../../components/PluginManager'))

export function apply() {
  const ctx = useCtx()

  ctx.slots.register({ name: 'app.skill-manager', id: 'default-skill-mgr', priority: 0 }, SkillManager)
  ctx.slots.register({ name: 'app.mcp-manager', id: 'default-mcp-mgr', priority: 0 }, McpManager)
  ctx.slots.register({ name: 'app.plugin-manager', id: 'default-plugin-mgr', priority: 0 }, PluginManager)

  console.log('[ui-market] Registered market UI plugins')
}
