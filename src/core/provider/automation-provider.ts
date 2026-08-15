// @ts-nocheck
/**
 * Automation Provider 插件 — 自动化触发器服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const automationProvider: Plugin = (ctx: any) => {
  const triggers = new Map<string, { name: string; config: any; enabled: boolean }>()

  const dispose = ctx.provide('automation', {
    registerTrigger: (name: string, config: any) => { triggers.set(name, { name, config, enabled: true }) },
    removeTrigger: (name: string) => { triggers.delete(name) },
    listTriggers: () => [...triggers.values()],
    enable: (name: string) => { const t = triggers.get(name); if (t) t.enabled = true },
    disable: (name: string) => { const t = triggers.get(name); if (t) t.enabled = false },
  })

  return dispose
}
