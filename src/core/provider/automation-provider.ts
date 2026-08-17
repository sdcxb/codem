/**
 * Automation Provider 插件 — 包装 automation-manager 函数式 API 并接入 ctx。
 *
 * 真实实现源：src/core/automation/automation-manager.ts
 * 支持：file_watch / timer / cron / issue_status 触发器
 *
 * 接入点：
 * - 第三方插件通过 ctx.automation.registerTrigger() 注册自定义触发器
 * - AgenticLoop 可通过 ctx.automation.start() 启动引擎
 */
import type { Plugin } from '../cordis/src/index.ts'
import { addTrigger, removeTrigger, getAutomationConfig, startAutomationEngines, stopAutomationEngines, refreshAutomationEngines } from '../automation/automation-manager.ts'

export const automationProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('automation', {
    registerTrigger(config: { type: string; [key: string]: any }): string {
      const id = config.id || `trigger-${Date.now()}`
      addTrigger({ ...config, id } as any)
      return id
    },
    removeTrigger(triggerId: string): void {
      removeTrigger(triggerId)
    },
    listTriggers(): Array<{ id: string; type: string; config: any }> {
      return getAutomationConfig().triggers.map(t => ({ id: t.id, type: t.type, config: t }))
    },
    start(onTrigger: (trigger: any) => void): void {
      startAutomationEngines(onTrigger)
    },
    stop(): void {
      stopAutomationEngines()
    },
    refresh(): void {
      refreshAutomationEngines()
    },
  })

  return dispose
}
