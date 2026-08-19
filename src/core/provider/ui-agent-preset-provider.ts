// @ts-nocheck
/**
 * @codem/ui-agent-preset — Agent 预设面板插件 (P2-7.14)
 *
 * 管理 Agent 预设（如 "代码助手"、"文档写作"等），用户可快速切换。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链 → app.sidebar）：
 * - 启动时：注册预设服务，侧边栏显示预设选择器
 * - 停止时：预设面板不可用，用户需手动配置 Agent
 */
import type { Plugin } from '../cordis/src/index.ts'

interface AgentPreset {
  id: string
  name: string
  description: string
  systemPrompt: string
  model?: string
  tools?: string[]
  icon?: string
}

class AgentPresetManager {
  private presets: Map<string, AgentPreset> = new Map()
  private activePreset: string | null = null

  register(preset: AgentPreset) {
    this.presets.set(preset.id, preset)
  }

  unregister(id: string) {
    this.presets.delete(id)
    if (this.activePreset === id) this.activePreset = null
  }

  get(id: string): AgentPreset | null {
    return this.presets.get(id) || null
  }

  list(): AgentPreset[] {
    return Array.from(this.presets.values())
  }

  setActive(id: string) {
    if (this.presets.has(id)) this.activePreset = id
  }

  getActive(): AgentPreset | null {
    return this.activePreset ? this.presets.get(this.activePreset) || null : null
  }
}

export const uiAgentPresetProvider: Plugin = (ctx: any) => {
  const manager = new AgentPresetManager()

  // 注册默认预设
  manager.register({
    id: 'code-assistant',
    name: '代码助手',
    description: '专注于代码编写和调试',
    systemPrompt: 'You are a coding assistant.',
    model: 'mimo-auto',
    icon: 'code',
  })
  manager.register({
    id: 'doc-writer',
    name: '文档写作',
    description: '专注于文档和报告撰写',
    systemPrompt: 'You are a documentation writer.',
    model: 'mimo-auto',
    icon: 'doc',
  })

  const dispose = ctx.provide('uiAgentPreset', {
    register(preset: any) { manager.register(preset) },
    unregister(id: string) { manager.unregister(id) },
    get(id: string) { return manager.get(id) },
    list() { return manager.list() },
    setActive(id: string) { manager.setActive(id) },
    getActive() { return manager.getActive() },
  })

  return dispose
}
