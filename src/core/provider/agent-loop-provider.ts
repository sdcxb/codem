// @ts-nocheck
/**
 * @codem/agent-loop — AgenticLoop Cordis 插件，Agent 推理循环引擎入口。
 *
 * 参考自 DSH (DeepSeek Harness) packages/core/agent-loop/src/index.ts:
 *   AgentLoop extends Service, static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
 *   create(id, options, meta) → publishes a running agent
 *   resume(ownerCtx, options) → restores from persistence
 *
 * 本 Provider 是 LLMEngine.getAgenticLoop() 的 Cordis 服务化封装：
 * - 通过 ctx.provide('agentLoop') 暴露 run/stream/stop/create/resume 接口
 * - 内部委托给 LLMEngine（通过 ctx.get('agentEngine') 获取）
 * - 关闭此 Provider 后，ctx.get('agentLoop') 返回 undefined，
 *   App.tsx 和 AgenticLoop 消费者需处理降级
 *
 * 消除重叠策略：
 * - LLMEngine.getAgenticLoop() 仍存在（兼容路径），但优先从 ctx.get('agentLoop') 获取
 * - Provider 是唯一注册入口，不再通过模块级单例绕过
 */
import type { Plugin } from '../cordis/src/index.ts'

export const agentLoopProvider: Plugin = (ctx: any) => {
  /** 获取底层 LLMEngine 实例 */
  const getEngine = () => {
    const engineSvc = ctx.get('agentEngine')
    if (engineSvc?.getEngine) return engineSvc.getEngine()
    if (engineSvc?.process) return engineSvc // duck-type
    return null
  }

  /** Per-session loop 池，支持并行执行 */
  // D6-1: LRU 淘汰 — 防止无限增长导致内存泄漏
  const LOOP_POOL_MAX = 20
  const loopPool = new Map<string, any>()

  /** LRU 淘汰：超过上限时删除最旧的 session loop */
  function evictLoopPoolIfNeeded(): void {
    while (loopPool.size > LOOP_POOL_MAX) {
      // Map 保持插入顺序，第一个是最旧的
      const oldestKey = loopPool.keys().next().value
      const oldLoop = loopPool.get(oldestKey)
      try { oldLoop?.stop?.() } catch (e) { console.warn('[agent-loop] LRU evict stop:', e) }
      loopPool.delete(oldestKey)
      console.log(`[agent-loop] LRU evicted session: ${oldestKey}`)
    }
  }

  const service = {
    /** 标记 Provider 是否活跃 */
    _active: true,

    /**
     * 运行 Agent 循环 — 委托给 LLMEngine.process()
     * @param messages - 消息列表
     * @param opts - 选项（agentId, sessionId, model 等）
     */
    async run(messages: any[], opts: any = {}) {
      const engine = getEngine()
      if (!engine) {
        return { content: 'Agent loop not available (provider disabled)', role: 'assistant' }
      }
      // 委托给 LLMEngine.process — 真实的 AgenticLoop 在此处被创建和执行
      return engine.process(messages[messages.length - 1]?.content || '', {
        ...opts,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
      })
    },

    /**
     * 流式运行 Agent 循环 — 委托给 LLMEngine
     * @param messages - 消息列表
     * @param opts - 选项
     */
    async *stream(messages: any[], opts: any = {}) {
      const engine = getEngine()
      if (!engine) {
        yield { type: 'text', text: 'Agent loop not available (provider disabled)' }
        return
      }
      // LLMEngine.process 返回 async iterator
      const result = await engine.process(messages[messages.length - 1]?.content || '', {
        ...opts,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        stream: true,
      })
      // 如果返回 async iterable，逐 yield
      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        yield* result
      } else if (result && typeof result[Symbol.iterator] === 'function') {
        for (const chunk of result) yield chunk
      } else {
        yield { type: 'text', text: result?.content || JSON.stringify(result) }
      }
    },

    /**
     * 获取或创建 AgenticLoop 实例（per-session）
     * 参考 DSH AgentLoop.create(id, options, meta) 模式
     */
    getLoop(agentId?: string, sessionId?: string) {
      // Per-session 池化
      if (sessionId) {
        const existing = loopPool.get(sessionId)
        if (existing) {
          // D6-1: LRU touch — 访问时移到末尾，标记为最近使用
          loopPool.delete(sessionId)
          loopPool.set(sessionId, existing)
          return existing
        }
      }

      const engine = getEngine()
      if (!engine) return null

      // 委托给 LLMEngine.getAgenticLoop — 真实的 AgenticLoop 在此处创建
      const loop = engine.getAgenticLoop?.(agentId, sessionId)
      if (!loop) return null

      if (sessionId) {
        // D6-1: 先淘汰，再写入
        evictLoopPoolIfNeeded()
        loopPool.set(sessionId, loop)
      }
      return loop
    },

    /**
     * 停止循环
     */
    stop(sessionId?: string) {
      if (sessionId) {
        const loop = loopPool.get(sessionId)
        if (loop?.stop) loop.stop()
        loopPool.delete(sessionId)
      } else {
        // 停止所有
        for (const [, loop] of loopPool) {
          if (loop?.stop) loop.stop()
        }
        loopPool.clear()
      }
    },

    /**
     * 清理 session 的 loop 资源
     */
    cleanupSession(sessionId: string) {
      const loop = loopPool.get(sessionId)
      if (loop?.dispose) loop.dispose()
      loopPool.delete(sessionId)
    },

    /**
     * 获取活跃 session 列表
     */
    getActiveSessions() {
      return [...loopPool.keys()]
    },
  }

  const disp = ctx.provide('agentLoop', service)

  // Composite dispose
  return () => {
    service._active = false
    // 清理所有 loop
    for (const [, loop] of loopPool) {
      if (loop?.stop) loop.stop()
    }
    loopPool.clear()
    if (disp) disp()
  }
}
