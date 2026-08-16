// @ts-nocheck
/**
 * Transcript Cache Provider 插件 — 包装真实对话缓存并接入 ctx。
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
  const dispose = ctx.provide('transcriptCache', {
    get(key: any): any {
      return TranscriptCache.get(key)
    },
    set(key: any, value: any): void {
      return TranscriptCache.set(key, value)
    },
    has(key: any): boolean {
      return TranscriptCache.has(key)
    },
    delete(key: any): void {
      return TranscriptCache.delete(key)
    },
    clear(): void {
      return TranscriptCache.clear()
    },
  })

  return dispose
}
