// @ts-nocheck
/**
 * @codem/plan-mode — 计划模式插件 (P1-7.10)
 *
 * 提供计划模式：LLM 先制定计划，用户审批后再执行。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册计划模式服务，AgenticLoop 检测到计划模式时先输出计划
 * - 停止时：计划模式不可用，AgenticLoop 直接执行（无计划审批）
 */
import type { Plugin } from '../cordis/src/index.ts'

interface Plan {
  id: string
  sessionId: string
  steps: { id: string; title: string; description: string }[]
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'completed'
  createdAt: number
  approvedAt?: number
}

class PlanModeManager {
  private plans: Map<string, Plan> = new Map()
  private sessionMode: Map<string, boolean> = new Map() // sessionId → isPlanMode

  enablePlanMode(sessionId: string) {
    this.sessionMode.set(sessionId, true)
  }

  disablePlanMode(sessionId: string) {
    this.sessionMode.set(sessionId, false)
  }

  isPlanMode(sessionId: string): boolean {
    return this.sessionMode.get(sessionId) || false
  }

  createPlan(planId: string, sessionId: string, steps: any[]): Plan {
    const plan: Plan = {
      id: planId,
      sessionId,
      steps,
      status: 'pending_approval',
      createdAt: Date.now(),
    }
    this.plans.set(planId, plan)
    return plan
  }

  approvePlan(planId: string): boolean {
    const plan = this.plans.get(planId)
    if (!plan || plan.status !== 'pending_approval') return false
    plan.status = 'approved'
    plan.approvedAt = Date.now()
    return true
  }

  rejectPlan(planId: string): boolean {
    const plan = this.plans.get(planId)
    if (!plan) return false
    plan.status = 'rejected'
    return true
  }

  getPlan(planId: string): Plan | null {
    return this.plans.get(planId) || null
  }

  getSessionPlans(sessionId: string): Plan[] {
    return Array.from(this.plans.values()).filter(p => p.sessionId === sessionId)
  }

  updatePlanStatus(planId: string, status: Plan['status']): boolean {
    const plan = this.plans.get(planId)
    if (!plan) return false
    plan.status = status
    return true
  }

  removePlan(planId: string) {
    this.plans.delete(planId)
  }
}

export const planModeProvider: Plugin = (ctx: any) => {
  const manager = new PlanModeManager()

  const dispose = ctx.provide('planMode', {
    enablePlanMode(sessionId: string) { manager.enablePlanMode(sessionId) },
    disablePlanMode(sessionId: string) { manager.disablePlanMode(sessionId) },
    isPlanMode(sessionId: string) { return manager.isPlanMode(sessionId) },
    createPlan(planId: string, sessionId: string, steps: any[]) { return manager.createPlan(planId, sessionId, steps) },
    approvePlan(planId: string) { return manager.approvePlan(planId) },
    rejectPlan(planId: string) { return manager.rejectPlan(planId) },
    getPlan(planId: string) { return manager.getPlan(planId) },
    getSessionPlans(sessionId: string) { return manager.getSessionPlans(sessionId) },
    updatePlanStatus(planId: string, status: any) { return manager.updatePlanStatus(planId, status) },
    removePlan(planId: string) { return manager.removePlan(planId) },
  })

  return dispose
}
