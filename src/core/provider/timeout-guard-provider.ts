// @ts-nocheck
/**
 * @codem/timeout — 超时管理插件 (P2-7.12)
 *
 * 管理工具调用和 LLM 调用的超时，防止无限等待。
 *
 * 功能链路融入（文档 6.2 链路 A+B: LLM + 工具执行链）：
 * - 启动时：注册超时管理器，每次调用时设置超时
 * - 停止时：无超时保护，可能无限等待
 */
import type { Plugin } from '../cordis/src/index.ts'

class TimeoutGuard {
  private defaultTimeout: number = 30000
  private llmTimeout: number = 120000
  private toolTimeouts: Map<string, number> = new Map()

  setDefaultTimeout(ms: number) { this.defaultTimeout = ms }
  setLLMTimeout(ms: number) { this.llmTimeout = ms }
  setToolTimeout(toolName: string, ms: number) { this.toolTimeouts.set(toolName, ms) }

  getTimeout(toolName?: string): number {
    if (toolName && this.toolTimeouts.has(toolName)) {
      return this.toolTimeouts.get(toolName)!
    }
    return this.defaultTimeout
  }

  getLLMTimeout(): number {
    return this.llmTimeout
  }

  async withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
    const ms = timeoutMs || this.defaultTimeout
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)

    try {
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
        }),
      ])
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}

export const timeoutGuardProvider: Plugin = (ctx: any) => {
  const guard = new TimeoutGuard()

  const dispose = ctx.provide('timeoutGuard', {
    setDefaultTimeout(ms: number) { guard.setDefaultTimeout(ms) },
    setLLMTimeout(ms: number) { guard.setLLMTimeout(ms) },
    setToolTimeout(toolName: string, ms: number) { guard.setToolTimeout(toolName, ms) },
    getTimeout(toolName?: string) { return guard.getTimeout(toolName) },
    getLLMTimeout() { return guard.getLLMTimeout() },
    async withTimeout(promise: any, timeoutMs?: number) { return guard.withTimeout(promise, timeoutMs) },
  })

  return dispose
}
