// @ts-nocheck
/**
 * Transcript Cache Provider 插件 — 直接暴露 TranscriptCache 对象到 ctx。
 *
 * 真实实现源：src/core/storage/transcript-cache.ts（TranscriptCache 对象）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('transcriptCache') 缓存/读取对话历史
 * - 替代直接 import { TranscriptCache }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { TranscriptCache } from '../storage/transcript-cache.ts'

export const transcriptCacheProvider: Plugin = (ctx: any) => {
  // 直接暴露对象 — 与 DSH 模式一致
  const dispose = ctx.provide('transcriptCache', TranscriptCache)

  return dispose
}
