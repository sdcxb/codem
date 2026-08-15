// @ts-nocheck
/**
 * Context Info Provider 插件 — 上下文信息服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const contextInfoProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('contextInfo', {
    getInstructions() { return 'You are a helpful AI coding assistant.' },
    getTime() { return new Date().toISOString() },
    getWorkspace() { return '/' },
    assemble() {
      return `${this.getInstructions()}\n\nCurrent time: ${this.getTime()}\nWorkspace: ${this.getWorkspace()}`
    },
  })

  return dispose
}
