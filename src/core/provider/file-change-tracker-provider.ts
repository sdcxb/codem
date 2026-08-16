// @ts-nocheck
/**
 * File Change Tracker Provider 插件 — 包装真实文件变更跟踪器并接入 ctx。
 *
 * 真实实现源：src/core/environment/file-change-tracker.ts（FileChangeTracker 类）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('fileChangeTracker') 跟踪文件变更
 * - 替代直接 import { FileChangeTracker }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { FileChangeTracker } from '../environment/file-change-tracker.ts'

export const fileChangeTrackerProvider: Plugin = (ctx: any) => {
  const tracker = new FileChangeTracker()

  const dispose = ctx.provide('fileChangeTracker', {
    track(filePath: string, changeType: string): void {
      return tracker.track(filePath, changeType)
    },
    getChanges(filter?: any): any[] {
      return tracker.getChanges(filter)
    },
    getChangedFiles(): string[] {
      return tracker.getChangedFiles()
    },
    clear(): void {
      return tracker.clear()
    },
    hasChanges(): boolean {
      return tracker.hasChanges()
    },
  })

  return dispose
}
