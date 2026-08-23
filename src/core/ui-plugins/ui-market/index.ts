// @ts-nocheck
/**
 * @codem/ui-market — 插件市场 UI 插件包
 *
 * 对标 DSH：组件同步导入，不用 React.lazy。
 */
import { SkillManager } from '../../../components/SkillManager'
import { McpManager } from '../../../components/McpManager'
import { PluginManager } from '../../../components/PluginManager'

export function apply(ctx: any) {
  const slots = ctx.get('slots')

  slots.register({ name: 'app.skill-manager', id: 'default-skill-mgr', priority: 0 }, SkillManager)
  slots.register({ name: 'app.mcp-manager', id: 'default-mcp-mgr', priority: 0 }, McpManager)
  slots.register({ name: 'app.plugin-manager', id: 'default-plugin-mgr', priority: 0 }, PluginManager)

  console.log('[ui-market] Registered market UI plugins')
}
