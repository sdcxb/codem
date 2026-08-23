// @ts-nocheck
/**
 * @codem/ui-trajectory — 执行轨迹 UI 插件
 *
 * 对标 DSH packages/client/ui-trajectory/src/client/index.ts。
 * 注册 TrajectoryPanel 组件到 Slot，同时提供轨迹记录服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { TrajectoryPanel } from '../../components/TrajectoryPanel'

interface TrajectoryStep {
  id: string
  sessionId: string
  type: 'llm_call' | 'tool_call' | 'tool_result' | 'user_input' | 'assistant_output' | 'error'
  data: any
  timestamp: number
  duration?: number
}

class TrajectoryService {
  private steps: Map<string, TrajectoryStep[]> = new Map()
  private listeners: Array<(sessionId: string, step: TrajectoryStep) => void> = []
  private maxStepsPerSession: number = 1000

  record(sessionId: string, type: TrajectoryStep['type'], data: any, duration?: number) {
    const step: TrajectoryStep = { id: crypto.randomUUID(), sessionId, type, data, timestamp: Date.now(), duration }
    if (!this.steps.has(sessionId)) this.steps.set(sessionId, [])
    const sessionSteps = this.steps.get(sessionId)!
    sessionSteps.push(step)
    if (sessionSteps.length > this.maxStepsPerSession) sessionSteps.shift()
    this.notify(sessionId, step)
    return step.id
  }
  getSessionTrajectory(sessionId: string): TrajectoryStep[] { return this.steps.get(sessionId) || [] }
  getAllSessions(): string[] { return [...this.steps.keys()] }
  clearSession(sessionId: string) { this.steps.delete(sessionId) }
  subscribe(listener: (sessionId: string, step: TrajectoryStep) => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter(l => l !== listener) } }
  private notify(sessionId: string, step: TrajectoryStep) { this.listeners.forEach(l => { try { l(sessionId, step) } catch (e) { console.warn('[uiTrajectory] listener failed', e) } }) }
}

export const uiTrajectoryProvider: Plugin = Object.assign(
  (ctx: any) => {
    const service = new TrajectoryService()

    const dispose = ctx.provide('uiTrajectory', {
      record: (sessionId: string, type: any, data: any, duration?: number) => service.record(sessionId, type, data, duration),
      getSessionTrajectory: (sessionId: string) => service.getSessionTrajectory(sessionId),
      getAllSessions: () => service.getAllSessions(),
      clearSession: (sessionId: string) => service.clearSession(sessionId),
      subscribe: (listener: any) => service.subscribe(listener),
    })

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.trajectory-panel', id: 'r8-trajectorypanel', priority: 5 }, TrajectoryPanel)

    // 使用 slots.inject 声明消费依赖：conversation.session 存在时注册
    const injectUnreg = slots.inject('conversation.session', () =>
      slots.register({ name: 'conversation.session', id: 'r8-trajectorypanel-sub', priority: 2 }, TrajectoryPanel)
    )

    return () => {
      if (dispose) dispose()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
