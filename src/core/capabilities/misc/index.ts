// @ts-nocheck
/**
 * P5.7 剩余能力族 — 凭证/附件/知识/调度/目标/计划/后台任务
 *
 * 这些能力族均为新建，没有需要迁移的现有代码。
 * 每个能力族定义 Service Definition + 默认 Provider。
 */
import type { Context, Plugin } from '../cordis/src/index.ts'

// ========== 凭证能力族 ==========
export interface Credentials {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  list(): string[]
}

declare module '../cordis/src/context.ts' {
  interface Context {
    credentials: Credentials
    attachments: Attachments
    knowledge: Knowledge
    schedule: Schedule
    goals: Goals
    plans: Plans
    jobs: Jobs
  }
}

export class LocalCredentials implements Credentials {
  private store: Record<string, string> = {}

  get(key: string): string | undefined {
    return this.store[key] || process.env?.[key] || localStorage?.getItem(key) || undefined
  }
  set(key: string, value: string): void {
    this.store[key] = value
    localStorage?.setItem(key, value)
  }
  delete(key: string): void {
    delete this.store[key]
    localStorage?.removeItem?.(key)
  }
  list(): string[] {
    return [...Object.keys(this.store)]
  }
}

// ========== 附件能力族 ==========
export interface Attachments {
  store(content: string | Uint8Array): Promise<string>
  get(hash: string): Promise<string | Uint8Array | undefined>
  delete(hash: string): Promise<void>
}

export class LocalAttachments implements Attachments {
  private store = new Map<string, string | Uint8Array>()

  async store(content: string | Uint8Array): Promise<string> {
    const hash = await this.hashContent(content)
    this.store.set(hash, content)
    return hash
  }
  async get(hash: string): Promise<string | Uint8Array | undefined> {
    return this.store.get(hash)
  }
  async delete(hash: string): Promise<void> {
    this.store.delete(hash)
  }
  private async hashContent(content: string | Uint8Array): Promise<string> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('')
  }
}

// ========== 知识能力族 ==========
export interface Knowledge {
  add(text: string, metadata?: Record<string, unknown>): Promise<string>
  search(query: string, limit?: number): Promise<Array<{ id: string; text: string; score: number }>>
  remove(id: string): Promise<void>
}

export class SqliteKnowledge implements Knowledge {
  private items: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = []

  async add(text: string, metadata?: Record<string, unknown>): Promise<string> {
    const id = crypto.randomUUID()
    this.items.push({ id, text, metadata })
    return id
  }
  async search(query: string, limit: number = 10): Promise<Array<{ id: string; text: string; score: number }>> {
    const q = query.toLowerCase()
    return this.items
      .map(item => ({ id: item.id, text: item.text, score: item.text.toLowerCase().includes(q) ? 1 : 0 }))
      .filter(r => r.score > 0)
      .slice(0, limit)
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter(i => i.id !== id)
  }
}

// ========== 调度能力族 ==========
export interface Schedule {
  addReminder(time: Date, message: string, sessionId?: string): string
  listReminders(sessionId?: string): Array<{ id: string; time: Date; message: string }>
  removeReminder(id: string): void
}

export class LocalSchedule implements Schedule {
  private reminders: Array<{ id: string; time: Date; message: string; sessionId?: string; timer?: any }> = []

  addReminder(time: Date, message: string, sessionId?: string): string {
    const id = crypto.randomUUID()
    const delay = time.getTime() - Date.now()
    const reminder: any = { id, time, message, sessionId }
    if (delay > 0) {
      reminder.timer = setTimeout(() => {
        console.log(`[Schedule] Reminder: ${message}`)
        this.reminders = this.reminders.filter(r => r.id !== id)
      }, delay)
    }
    this.reminders.push(reminder)
    return id
  }
  listReminders(sessionId?: string): Array<{ id: string; time: Date; message: string }> {
    return this.reminders
      .filter(r => !sessionId || r.sessionId === sessionId)
      .map(({ id, time, message }) => ({ id, time, message }))
  }
  removeReminder(id: string): void {
    const r = this.reminders.find(r => r.id === id)
    if (r?.timer) clearTimeout(r.timer)
    this.reminders = this.reminders.filter(r => r.id !== id)
  }
}

// ========== 目标能力族 ==========
export interface Goals {
  set(goal: { title: string; description?: string; criteria?: string[] }): string
  get(goalId: string): { id: string; title: string; description?: string; criteria?: string[]; status: string } | undefined
  list(): Array<{ id: string; title: string; status: string }>
  update(goalId: string, status: string): void
  remove(goalId: string): void
}

export class LocalGoals implements Goals {
  private goals: Array<{ id: string; title: string; description?: string; criteria?: string[]; status: string }> = []

  set(goal: { title: string; description?: string; criteria?: string[] }): string {
    const id = crypto.randomUUID()
    this.goals.push({ id, ...goal, status: 'active' })
    return id
  }
  get(goalId: string) {
    return this.goals.find(g => g.id === goalId)
  }
  list() {
    return this.goals.map(({ id, title, status }) => ({ id, title, status }))
  }
  update(goalId: string, status: string): void {
    const g = this.goals.find(g => g.id === goalId)
    if (g) g.status = status
  }
  remove(goalId: string): void {
    this.goals = this.goals.filter(g => g.id !== goalId)
  }
}

// ========== 计划能力族 ==========
export interface Plans {
  create(title: string, steps: string[]): string
  get(planId: string): { id: string; title: string; steps: Array<{ text: string; done: boolean }> } | undefined
  list(): Array<{ id: string; title: string; progress: number }>
  updateStep(planId: string, stepIndex: number, done: boolean): void
  remove(planId: string): void
}

export class LocalPlans implements Plans {
  private plans: Array<{ id: string; title: string; steps: Array<{ text: string; done: boolean }> }> = []

  create(title: string, steps: string[]): string {
    const id = crypto.randomUUID()
    this.plans.push({ id, title, steps: steps.map(text => ({ text, done: false })) })
    return id
  }
  get(planId: string) {
    return this.plans.find(p => p.id === planId)
  }
  list() {
    return this.plans.map(p => ({
      id: p.id,
      title: p.title,
      progress: p.steps.filter(s => s.done).length / p.steps.length,
    }))
  }
  updateStep(planId: string, stepIndex: number, done: boolean): void {
    const p = this.plans.find(p => p.id === planId)
    if (p && p.steps[stepIndex]) p.steps[stepIndex].done = done
  }
  remove(planId: string): void {
    this.plans = this.plans.filter(p => p.id !== planId)
  }
}

// ========== 后台任务能力族 ==========
export interface Jobs {
  start(task: { name: string; fn: () => Promise<any> }): string
  get(jobId: string): { id: string; name: string; status: string; result?: any; error?: string } | undefined
  list(): Array<{ id: string; name: string; status: string }>
  cancel(jobId: string): void
}

export class LocalJobs implements Jobs {
  private jobs: Map<string, { id: string; name: string; status: string; result?: any; error?: string; abortController: AbortController }> = new Map()

  start(task: { name: string; fn: () => Promise<any> }): string {
    const id = crypto.randomUUID()
    const abortController = new AbortController()
    const job: any = { id, name: task.name, status: 'running', abortController }
    this.jobs.set(id, job)

    task.fn()
      .then(result => {
        job.status = 'completed'
        job.result = result
      })
      .catch(err => {
        job.status = 'failed'
        job.error = err.message
      })

    return id
  }

  get(jobId: string) {
    const j = this.jobs.get(jobId)
    if (!j) return undefined
    return { id: j.id, name: j.name, status: j.status, result: j.result, error: j.error }
  }

  list() {
    return [...this.jobs.values()].map(j => ({ id: j.id, name: j.name, status: j.status }))
  }

  cancel(jobId: string): void {
    const j = this.jobs.get(jobId)
    if (j) {
      j.abortController.abort()
      j.status = 'cancelled'
    }
  }
}

// ========== 插件定义 ==========
export const inject = [] as const
export const provide = ['credentials', 'attachments', 'knowledge', 'schedule', 'goals', 'plans', 'jobs'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('credentials', new LocalCredentials())
  ctx.provide('attachments', new LocalAttachments())
  ctx.provide('knowledge', new SqliteKnowledge())
  ctx.provide('schedule', new LocalSchedule())
  ctx.provide('goals', new LocalGoals())
  ctx.provide('plans', new LocalPlans())
  ctx.provide('jobs', new LocalJobs())
}
