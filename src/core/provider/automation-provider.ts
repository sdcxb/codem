// @ts-nocheck
/**
 * Automation Provider 插件 — 包装真实 AutomationManager 并接入 ctx。
 *
 * 真实实现源：src/core/automation/automation-manager.ts（375 行完整实现）
 * 支持：file_watch / timer / cron / issue_status 触发器
 *
 * 适配层说明：
 * - AutomationManager 原始接口通过 getSettingJSON + getInboxManager 直接调用
 * - 本 Provider 为其创建 ctx 适配层，使其可被第三方插件通过 ctx.automation 使用
 * - 核心业务仍直接使用 AutomationManager，ctx.automation 作为 DI 接口暴露
 *
 * 接入点：
 * - 第三方插件通过 ctx.automation.registerTrigger() 注册自定义触发器
 * - AgenticLoop 可通过 ctx.automation.checkTriggers() 检查到期触发器
 */
import type { Plugin } from '../cordis/src/index.ts'
import { AutomationManager } from '../automation/automation-manager.ts'

export const automationProvider: Plugin = (ctx: any) => {
  const manager = new AutomationManager(ctx)

  const dispose = ctx.provide('automation', {
    registerTrigger(config: { type: string; [key: string]: any }): string {
      return manager.registerTrigger(config)
    },
    removeTrigger(triggerId: string): void {
      manager.removeTrigger(triggerId)
    },
    listTriggers(): Array<{ id: string; type: string; config: any }> {
      return manager.listTriggers()
    },
    async checkTriggers(): Promise<Array<{ triggerId: string; payload: any }>> {
      return manager.checkTriggers()
    },
    async fire(triggerId: string, payload?: any): Promise<void> {
      return manager.fireTrigger(triggerId, payload)
    },
  })

  return dispose
}
