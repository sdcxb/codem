// @ts-nocheck
/**
 * @codem/invariants — 运行时不变量插件 (P2-7.12)
 *
 * 定义运行时不变量（invariants），在关键点检查是否违反。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链 → 每轮迭代后检查）：
 * - 启动时：注册不变量检查器
 * - 停止时：不检查不变量，可能产生不一致状态
 */
import type { Plugin } from '../cordis/src/index.ts'

type InvariantCheck = () => boolean | string // true=通过, string=错误消息

interface Invariant {
  id: string
  description: string
  check: InvariantCheck
  severity: 'error' | 'warn'
}

class InvariantsGuard {
  private invariants: Map<string, Invariant> = new Map()
  private violations: { invariantId: string; message: string; timestamp: number }[] = []

  register(id: string, description: string, check: InvariantCheck, severity: 'error' | 'warn' = 'error') {
    this.invariants.set(id, { id, description, check, severity })
  }

  unregister(id: string) {
    this.invariants.delete(id)
  }

  checkAll(): { passed: boolean; violations: { id: string; description: string; message: string; severity: string }[] } {
    const violations: { id: string; description: string; message: string; severity: string }[] = []
    for (const inv of this.invariants.values()) {
      const result = inv.check()
      if (result !== true) {
        const message = typeof result === 'string' ? result : 'Invariant violated'
        violations.push({ id: inv.id, description: inv.description, message, severity: inv.severity })
        this.violations.push({ invariantId: inv.id, message, timestamp: Date.now() })
      }
    }
    return { passed: violations.length === 0, violations }
  }

  getViolations() {
    return this.violations
  }

  clearViolations() {
    this.violations = []
  }

  listInvariants() {
    return Array.from(this.invariants.values()).map(({ id, description, severity }) => ({ id, description, severity }))
  }
}

export const invariantsGuardProvider: Plugin = (ctx: any) => {
  const guard = new InvariantsGuard()

  const dispose = ctx.provide('invariantsGuard', {
    register(id: string, description: string, check: any, severity?: any) {
      guard.register(id, description, check, severity)
    },
    unregister(id: string) { guard.unregister(id) },
    checkAll() { return guard.checkAll() },
    getViolations() { return guard.getViolations() },
    clearViolations() { guard.clearViolations() },
    listInvariants() { return guard.listInvariants() },
  })

  return dispose
}
