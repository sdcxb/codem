// @ts-nocheck
/**
 * Telemetry Provider 插件 — 直接暴露 TelemetryCollector 实例到 ctx。
 *
 * 真实实现源：src/core/telemetry/telemetry.ts（TelemetryCollector + getTelemetry()）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('telemetry') 记录指标
 * - 替代直接 import { getTelemetry }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getTelemetry } from '../telemetry/telemetry.ts'

export const telemetryProvider: Plugin = (ctx: any) => {
  const collector = getTelemetry()

  // 直接暴露实例 — 与 DSH 模式一致
  const dispose = ctx.provide('telemetry', collector)

  return dispose
}
