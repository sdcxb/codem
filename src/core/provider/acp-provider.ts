// @ts-nocheck
/**
 * @codem/acp — ACP (Automation Control Protocol) 插件（从 hostClient 拆分）
 *
 * 自动化控制协议，管理自动化触发器和调度。
 * 接入 AutomationManager 作为 ctx 接口适配层。
 *
 * 功能链路融入（链路 F: Host/Client 链 → ACP 自动化）：
 * - 启动时：注册 ACP 服务，可注册自动化触发器
 * - 停止时：自动化触发器不可用
 */
import type { Plugin } from '../cordis/src/index.ts'

class AcpService {
  private automations = new Map<string, { name: string; type: string; config: any; enabled: boolean }>()
  private listeners: Array<(event: string, data: any) => void> = []

  registerAutomation(name: string, config: { type: string; [key: string]: any }): void {
    this.automations.set(name, { name, type: config.type, config, enabled: true })

    // 接入 automationManager（如果可用）
    try {
      const automation = (globalThis as any).__codemAutomationManager
      if (automation?.registerTrigger) {
        automation.registerTrigger({ type: config.type, ...config })
      }
    } catch (e) { console.warn('[acp-provider.ts]', e) }
  }

  unregisterAutomation(name: string): void {
    this.automations.delete(name)
  }

  listAutomations(): Array<{ name: string; type: string; enabled: boolean }> {
    return [...this.automations.values()].map(a => ({ name: a.name, type: a.type, enabled: a.enabled }))
  }

  async trigger(name: string, payload?: any): Promise<{ triggered: boolean; result?: any; error?: string }> {
    const auto = this.automations.get(name)
    if (!auto) return { triggered: false, error: `Automation "${name}" not found` }
    if (!auto.enabled) return { triggered: false, error: `Automation "${name}" is disabled` }

    // 接入 automationManager
    try {
      const automation = (globalThis as any).__codemAutomationManager
      if (automation?.fire) {
        const result = await automation.fire(name, payload)
        return { triggered: true, result }
      }
    } catch (err: any) {
      return { triggered: false, error: err.message }
    }

    return { triggered: true }
  }

  enable(name: string) {
    const a = this.automations.get(name)
    if (a) a.enabled = true
  }

  disable(name: string) {
    const a = this.automations.get(name)
    if (a) a.enabled = false
  }

  subscribe(listener: (event: string, data: any) => void) {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }
}

export const acpProvider: Plugin = (ctx: any) => {
  const service = new AcpService()

  const dispose = ctx.provide('acp', {
    registerAutomation: (name: string, config: any) => service.registerAutomation(name, config),
    unregisterAutomation: (name: string) => service.unregisterAutomation(name),
    listAutomations: () => service.listAutomations(),
    trigger: (name: string, payload?: any) => service.trigger(name, payload),
    enable: (name: string) => service.enable(name),
    disable: (name: string) => service.disable(name),
    subscribe: (listener: any) => service.subscribe(listener),
  })

  return dispose
}
