// @ts-nocheck
/**
 * @codem/spill — 溢出管理，上下文超限时的分片策略
 */
import type { Plugin } from '../cordis/src/index.ts'

export const spillProvider: Plugin = (ctx: any) => {
  const s = {
    threshold: 8000, maxSpillSize: 4000,
    setThreshold(t) { this.threshold = t },
    shouldSpill(contextLength) { return contextLength >= this.threshold },
    async spill(messages, opts={}) { const half=Math.floor(messages.length/2); return {kept:messages.slice(half),spilled:messages.slice(0,half),summary:'Spilled '+half+' messages'} },
    async restore(spilledData) { return spilledData.spilled||[] },
  }
  return ctx.provide('spill', s)
}
