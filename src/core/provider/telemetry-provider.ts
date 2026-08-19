// @ts-nocheck
/**
 * Telemetry Provider 插件 — 包装真实遥测服务并接入 ctx。
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
  // 使用全局 getTelemetry() 获取单例实例
  const collector = getTelemetry()

  const dispose = ctx.provide('telemetry', {
    record(metric: string, value: any): void {
      return collector.record(metric, value)
    },
    increment(metric: string, value?: number): void {
      return collector.increment(metric, value)
    },
    getMetrics(): any {
      return collector.getMetrics()
    },
    flush(): void {
      return collector.flush?.()
    },
  })

  return dispose
}
