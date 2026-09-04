// @ts-nocheck
/**
 * @codem/ui-trajectory — 执行轨迹 UI 插件
 *
 * 对标 DSH packages/client/ui-trajectory/src/client/index.ts。
 * 注册 TrajectoryPanel 组件到 Slot，同时提供轨迹记录服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * 持久化（2026-09）：步骤批量写入事件日志（session_events，type=trajectory_step）。
 * 面板打开历史会话时从日志回放全量轨迹（llm/工具/结果/错误/轮次），
 * 重启后不再只剩消息回退的 user/assistant。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getEventLog } from '../storage/event-log'
import { TrajectoryPanel } from '../../components/TrajectoryPanel'

interface TrajectoryStep {
  id: string
  sessionId: string
  type: 'llm_call' | 'tool_call' | 'tool_result' | 'user_input' | 'assistant_output' | 'error' | 'turn_end'
  data: any
  timestamp: number
  duration?: number
}

/** 事件日志中的轨迹事件类型。 */
const TRAJECTORY_EVENT_TYPE = 'trajectory_step'
/** 批量落库间隔（ms）—— EventLog.append 每次全量持久化文件，逐条写会卡。 */
const FLUSH_INTERVAL_MS = 2000
/** 每会话内存步骤上限。 */
const MAX_STEPS_PER_SESSION = 1000

class TrajectoryService {
  private steps: Map<string, TrajectoryStep[]> = new Map()
  private listeners: Array<(sessionId: string, step: TrajectoryStep) => void> = []
  /** 待落库批次（sessionId → 步骤原始数据），DB 未就绪时保留重试。 */
  private pending: Map<string, Array<{ type: string; data: any; duration?: number; timestamp: number }>> = new Map()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // 周期 flush：把 pending 批量写事件日志（一次事务 + 一次文件持久化）。
    this.flushTimer = setInterval(() => { this.flushAll() }, FLUSH_INTERVAL_MS)
  }

  record(sessionId: string, type: TrajectoryStep['type'], data: any, duration?: number) {
    const step: TrajectoryStep = { id: crypto.randomUUID(), sessionId, type, data, timestamp: Date.now(), duration }
    // 内存（实时订阅推送；DB 异常时的兜底）
    if (!this.steps.has(sessionId)) this.steps.set(sessionId, [])
    const sessionSteps = this.steps.get(sessionId)!
    sessionSteps.push(step)
    if (sessionSteps.length > MAX_STEPS_PER_SESSION) sessionSteps.shift()
    this.notify(sessionId, step)

    // 持久化批次（异步周期落库，不阻塞主循环）
    if (!this.pending.has(sessionId)) this.pending.set(sessionId, [])
    const batch = this.pending.get(sessionId)!
    batch.push({ type, data, duration, timestamp: step.timestamp })
    if (batch.length > 200) this.flushSession(sessionId) // 批过大提前落
    return step.id
  }

  /** 落库单个会话的 pending 批次。DB 未就绪时保留待重试。 */
  flushSession(sessionId: string): void {
    const batch = this.pending.get(sessionId)
    if (!batch || batch.length === 0) return
    this.pending.delete(sessionId)
    try {
      getEventLog().appendBatch(
        sessionId,
        batch.map((b) => ({
          type: TRAJECTORY_EVENT_TYPE,
          payload: { step: { id: crypto.randomUUID(), sessionId, type: b.type, data: b.data, timestamp: b.timestamp, ...(b.duration === undefined ? {} : { duration: b.duration }) } },
        })),
      )
    } catch {
      // DB 未就绪（启动早期）/异常：放回队列下次再试；诊断数据可容忍延迟。
      const retained = this.pending.get(sessionId) ?? []
      this.pending.set(sessionId, [...batch, ...retained])
    }
  }

  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.flushSession(sessionId)
  }

  /** 返回会话轨迹：先落库，再从事件日志回放（含历史+本次运行）。 */
  getSessionTrajectory(sessionId: string): TrajectoryStep[] {
    this.flushSession(sessionId)
    const out: TrajectoryStep[] = []
    try {
      for (const ev of getEventLog().readAll(sessionId)) {
        if (ev.type !== TRAJECTORY_EVENT_TYPE) continue
        const step = ev.payload?.step
        if (step && typeof step.type === 'string' && step.timestamp != null) {
          out.push({ id: step.id ?? `ev-${ev.seq}`, sessionId, type: step.type, data: step.data ?? {}, timestamp: step.timestamp, ...(step.duration === undefined ? {} : { duration: step.duration }) })
        }
      }
    } catch {
      // 事件表不可用：回退内存（本次运行内）。
      return this.steps.get(sessionId) || []
    }
    return out
  }
  getAllSessions(): string[] { return [...this.steps.keys()] }
  clearSession(sessionId: string) { this.steps.delete(sessionId); this.pending.delete(sessionId) }
  subscribe(listener: (sessionId: string, step: TrajectoryStep) => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter(l => l !== listener) } }
  private notify(sessionId: string, step: TrajectoryStep) { this.listeners.forEach(l => { try { l(sessionId, step) } catch (e) { console.warn('[uiTrajectory] listener failed', e) } }) }
  dispose(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.flushAll()
  }
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
      service.dispose()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
