// @ts-nocheck
/**
 * Plans Provider 插件 — 结构化任务计划管理。
 *
 * F6: 深化 — 接入 storage/goal-storage.ts 持久化计划数据。
 * 支持 AgenticLoop 的 planSteps 结果持久化和 UI 进度展示。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSettingJSON, setSettingJSON } from '../storage/settings.ts'

export const plansProvider: Plugin = (ctx: any) => {
  /** Load plans from persisted settings */
  const loadPlans = (): any[] => {
    return getSettingJSON<any[]>('plans-store', [])
  }

  /** Save plans to persisted settings */
  const savePlans = (plans: any[]) => {
    setSettingJSON('plans-store', plans)
  }

  // In-memory working copy
  let plansStore = loadPlans()

  const dispose = ctx.provide('plans', {
    _active: true,

    /** Create a new plan */
    create(title: string, steps: string[], sessionId?: string): string {
      const id = crypto.randomUUID()
      plansStore.push({
        id,
        title,
        steps: steps.map(text => ({ text, done: false })),
        sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      savePlans(plansStore)
      return id
    },

    /** Get a plan by ID */
    get(planId: string): any | undefined {
      return plansStore.find(p => p.id === planId)
    },

    /** List all plans with progress */
    list(sessionId?: string): Array<{ id: string; title: string; progress: number; sessionId?: string }> {
      return plansStore
        .filter(p => !sessionId || p.sessionId === sessionId)
        .map(p => ({
          id: p.id,
          title: p.title,
          progress: p.steps.length > 0 ? p.steps.filter((s: any) => s.done).length / p.steps.length : 0,
          sessionId: p.sessionId,
        }))
    },

    /** Update a step's done status */
    updateStep(planId: string, stepIndex: number, done: boolean): void {
      const p = plansStore.find(p => p.id === planId)
      if (p && p.steps[stepIndex]) {
        p.steps[stepIndex].done = done
        p.updatedAt = Date.now()
        savePlans(plansStore)
      }
    },

    /** Add a step to an existing plan */
    addStep(planId: string, text: string): void {
      const p = plansStore.find(p => p.id === planId)
      if (p) {
        p.steps.push({ text, done: false })
        p.updatedAt = Date.now()
        savePlans(plansStore)
      }
    },

    /** Remove a plan */
    remove(planId: string): void {
      const idx = plansStore.findIndex(p => p.id === planId)
      if (idx >= 0) {
        plansStore.splice(idx, 1)
        savePlans(plansStore)
      }
    },

    /** Get the active plan for a session (most recent unfinished) */
    getActivePlan(sessionId?: string): any | undefined {
      const sessionPlans = plansStore
        .filter(p => !sessionId || p.sessionId === sessionId)
        .filter(p => p.steps.some((s: any) => !s.done))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return sessionPlans[0]
    },
  })

  // Composite dispose
  const compositeDispose = () => {
    // Persist current state
    savePlans(plansStore)
    dispose()
  }
  return compositeDispose
}
