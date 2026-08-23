// @ts-nocheck
/**
 * File Change Tracker Provider 插件 — 直接暴露 FileChangeTracker 实例到 ctx。
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

  // 直接暴露实例 — 与 DSH 模式一致
  const dispose = ctx.provide('fileChangeTracker', tracker)

  return dispose
}
