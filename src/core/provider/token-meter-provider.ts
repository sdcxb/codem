// @ts-nocheck
/**
 * @codem/token-meter — Token 计量插件
 *
 * 独立计量 LLM 调用的 Token 用量，与 CostTracker 配合使用。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链 + 链路 B: 工具执行链）：
 * - 启动时：注册 token 计量服务，每次 LLM 调用后记录 usage
 * - 停止时：token 计量不可用，CostTracker 仍可工作但无细粒度 token 数据
 *   → 文档 6.4 辅助链路: 成本追踪 | ⚠️ 无限费用 | 成本降级跳过
 */
import type { Plugin } from '../cordis/src/index.ts'

interface TokenUsageRecord {
  sessionId: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  timestamp: number
}

class TokenMeter {
  private records: TokenUsageRecord[] = []

  record(usage: TokenUsageRecord) {
    this.records.push(usage)
  }

  getSessionUsage(sessionId: string): TokenUsageRecord[] {
    return this.records.filter(r => r.sessionId === sessionId)
  }

  getTotalTokens(): number {
    return this.records.reduce((sum, r) => sum + r.totalTokens, 0)
  }

  reset(sessionId?: string) {
    if (sessionId) {
      this.records = this.records.filter(r => r.sessionId !== sessionId)
    } else {
      this.records = []
    }
  }

  exportReport() {
    return {
      totalTokens: this.getTotalTotalTokens(),
      bySession: this.getSessionBreakdown(),
      byModel: this.getModelBreakdown(),
    }
  }

  private getTotalTotalTokens(): number {
    return this.records.reduce((sum, r) => sum + r.totalTokens, 0)
  }

  private getSessionBreakdown(): Record<string, number> {
    const map: Record<string, number> = {}
    for (const r of this.records) {
      map[r.sessionId] = (map[r.sessionId] || 0) + r.totalTokens
    }
    return map
  }

  private getModelBreakdown(): Record<string, number> {
    const map: Record<string, number> = {}
    for (const r of this.records) {
      const key = `${r.provider}/${r.model}`
      map[key] = (map[key] || 0) + r.totalTokens
    }
    return map
  }
}

export const tokenMeterProvider: Plugin = (ctx: any) => {
  const meter = new TokenMeter()

  const dispose = ctx.provide('tokenMeter', {
    record(usage: TokenUsageRecord) { meter.record(usage) },
    getSessionUsage(sessionId: string) { return meter.getSessionUsage(sessionId) },
    getTotalTokens() { return meter.getTotalTokens() },
    reset(sessionId?: string) { meter.reset(sessionId) },
    exportReport() { return meter.exportReport() },
  })

  return dispose
}
