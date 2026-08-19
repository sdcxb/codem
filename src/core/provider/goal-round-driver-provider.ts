// @ts-nocheck
/**
 * @codem/goal-round-driver — 目标轮次驱动插件 (P1-7.10)
 *
 * 管理目标驱动的多轮执行：设置目标 → 分解步骤 → 逐步执行 → 验证完成。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册目标驱动器，AgenticLoop 每轮迭代后检查目标完成状态
 * - 停止时：目标驱动不可用，AgenticLoop 使用默认的 maxIterations
 */
import type { Plugin } from '../cordis/src/index.ts'

interface GoalStep {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  result?: string
}

interface GoalRoundState {
  goalId: string
  goal: string
  steps: GoalStep[]
  currentStepIndex: number
  totalRounds: number
  maxRounds: number
  status: 'planning' | 'executing' | 'completed' | 'failed'
}

class GoalRoundDriver {
  private goals: Map<string, GoalRoundState> = new Map()

  createGoal(goalId: string, goal: string, maxRounds: number = 20): GoalRoundState {
    const state: GoalRoundState = {
      goalId,
      goal,
      steps: [],
      currentStepIndex: 0,
      totalRounds: 0,
      maxRounds,
      status: 'planning',
    }
    this.goals.set(goalId, state)
    return state
  }

  setSteps(goalId: string, steps: GoalStep[]) {
    const state = this.goals.get(goalId)
    if (state) {
      state.steps = steps
      state.status = 'executing'
    }
  }

  advanceRound(goalId: string): boolean {
    const state = this.goals.get(goalId)
    if (!state) return false
    state.totalRounds++
    return state.totalRounds < state.maxRounds
  }

  completeStep(goalId: string, stepId: string, result?: string) {
    const state = this.goals.get(goalId)
    if (!state) return
    const step = state.steps.find(s => s.id === stepId)
    if (step) {
      step.status = 'completed'
      step.result = result
      state.currentStepIndex++
      if (state.currentStepIndex >= state.steps.length) {
        state.status = 'completed'
      }
    }
  }

  failStep(goalId: string, stepId: string, error?: string) {
    const state = this.goals.get(goalId)
    if (!state) return
    const step = state.steps.find(s => s.id === stepId)
    if (step) {
      step.status = 'failed'
      step.result = error
      state.status = 'failed'
    }
  }

  getGoal(goalId: string): GoalRoundState | null {
    return this.goals.get(goalId) || null
  }

  getCurrentStep(goalId: string): GoalStep | null {
    const state = this.goals.get(goalId)
    if (!state || state.currentStepIndex >= state.steps.length) return null
    return state.steps[state.currentStepIndex]
  }

  isGoalComplete(goalId: string): boolean {
    const state = this.goals.get(goalId)
    return state?.status === 'completed'
  }

  removeGoal(goalId: string) {
    this.goals.delete(goalId)
  }
}

export const goalRoundDriverProvider: Plugin = (ctx: any) => {
  const driver = new GoalRoundDriver()

  const dispose = ctx.provide('goalRoundDriver', {
    createGoal(goalId: string, goal: string, maxRounds?: number) { return driver.createGoal(goalId, goal, maxRounds) },
    setSteps(goalId: string, steps: any[]) { driver.setSteps(goalId, steps) },
    advanceRound(goalId: string) { return driver.advanceRound(goalId) },
    completeStep(goalId: string, stepId: string, result?: string) { driver.completeStep(goalId, stepId, result) },
    failStep(goalId: string, stepId: string, error?: string) { driver.failStep(goalId, stepId, error) },
    getGoal(goalId: string) { return driver.getGoal(goalId) },
    getCurrentStep(goalId: string) { return driver.getCurrentStep(goalId) },
    isGoalComplete(goalId: string) { return driver.isGoalComplete(goalId) },
    removeGoal(goalId: string) { driver.removeGoal(goalId) },
  })

  return dispose
}
