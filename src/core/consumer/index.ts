/**
 * Codem 核心工具 Consumer 包。
 *
 * 提供 Cordis-aware 的工具基类和辅助函数，
 * 让工具通过 ctx 消费核心服务，而非直接 import 单例。
 *
 * 使用方式：
 * ```typescript
 * import { defineTool, useCtx } from './consumer'
 *
 * export const myTool = defineTool({
 *   name: 'my_tool',
 *   description: 'Do something cool',
 *   async execute({ input }) {
 *     const ctx = useCtx()
 *     const llm = ctx.get('llm')
 *     const result = await llm.complete({ ... })
 *     return result
 *   }
 * })
 * ```
 */

import type { Context } from '../cordis/src/index.ts'
import type {} from '../provider/service-types'
import { useState, useEffect } from 'react'

/** 当前活跃的 Cordis Context（由 App.tsx 初始化时设置）。 */
let _activeCtx: Context | null = null

/** 是否已设置过 active context（用于诊断日志）。 */
let _ctxReady = false

/** ctx 就绪回调集合（替代 SlotBridge 中的 16ms 轮询） */
const _ctxReadyCallbacks = new Set<() => void>()

/** 订阅 ctx 就绪事件。如果 ctx 已就绪，回调会被同步调用。 */
export function onCtxReady(cb: () => void): () => void {
  if (_ctxReady) {
    cb()
    return () => {}
  }
  _ctxReadyCallbacks.add(cb)
  return () => { _ctxReadyCallbacks.delete(cb) }
}

// ====== Cordis 服务获取增强：重试 + fallback ======

/**
 * 等待服务可用，最多重试 maxRetries 次。
 * 对标 DSH 的 assertEntriesActivated：使用事件驱动而非纯轮询。
 * 首次尝试同步获取，失败后等待 internal/service 事件，
 * 最后回退到 setTimeout 给 fiber 时间激活。
 * 返回 service 或 null（如果超时仍未就绪）。
 */
async function waitForService<T>(
  name: string,
  maxRetries = 3,
  delay = 16,
): Promise<T | null> {
  for (let i = 0; i < maxRetries; i++) {
    const ctx = tryGetCtx()
    if (ctx) {
      try {
        const svc = ctx.get(name)
        if (svc) return svc as T
      } catch {}
    }
    // 让出控制权，等待 fiber 激活
    await new Promise(r => setTimeout(r, delay))
  }
  return null
}

/**
 * 设置活跃的 Cordis Context。
 * 在 App.tsx 的 getCordisContext() 中调用。
 */
export function setActiveContext(ctx: Context) {
  _activeCtx = ctx
  _ctxReady = true
  console.log('[Consumer] Active context set — services ready')
  // 通知所有等待 ctx 就绪的回调（替代 SlotBridge 的轮询）
  for (const cb of _ctxReadyCallbacks) {
    try { cb() } catch (e) { console.warn('[Consumer] ctx ready callback error:', e) }
  }
  _ctxReadyCallbacks.clear()
}

/**
 * 获取当前活跃的 Cordis Context。
 * 工具内部使用此函数获取 ctx，然后通过 ctx.get() 消费服务。
 */
export function useCtx(): Context {
  if (!_activeCtx) {
    throw new Error('Cordis Context not initialized. Call setActiveContext() first.')
  }
  return _activeCtx
}

/**
 * 获取当前活跃的 Cordis Context（可能为 null）。
 */
export function tryGetCtx(): Context | null {
  return _activeCtx
}

/**
 * React hook: 检测 Cordis Context 是否已就绪（事件驱动，无轮询）。
 * 对标 DSH boot() 完成后 context 立即可用。
 * 在 ctx 就绪后触发一次重渲染。
 */
export function useCtxReady(): boolean {
  const [ready, setReady] = useState(() => tryGetCtx() !== null)
  useEffect(() => {
    if (ready) return
    return onCtxReady(() => setReady(true))
  }, [ready])
  return ready
}

/**
 * 异步获取 Cordis 服务，带重试等待。
 * 当 fiber 尚未 ACTIVE 时，ctx.get() 返回 undefined。
 * 此函数会重试几次，给 fiber 时间完成激活。
 */
export async function getServiceAsync<T = any>(name: string): Promise<T | null> {
  if (!_activeCtx) {
    console.warn(`[Consumer] Context not set when requesting service "${name}"`)
    return null
  }
  try {
    const svc = _activeCtx.get(name)
    if (svc) return svc as T
  } catch {}
  // 第一次获取失败，重试等待
  return waitForService<T>(name)
}

/**
 * 同步获取 Cordis 服务，失败时返回 null 并发出警告。
 */
export function getServiceSync<T = any>(name: string): T | null {
  if (!_activeCtx) return null
  try {
    return (_activeCtx.get(name) as T) ?? null
  } catch {
    return null
  }
}

/** 工具定义接口。 */
export interface ToolDefinition<TInput = any, TOutput = any> {
  /** 工具名称（唯一标识）。 */
  name: string
  /** 工具描述（用于 LLM function calling）。 */
  description: string
  /** 输入参数 JSON Schema。 */
  inputSchema?: {
    type: string
    properties: Record<string, any>
    required?: string[]
  }
  /** 执行函数。可以通过 useCtx() 获取 Cordis Context。 */
  execute(input: TInput): Promise<TOutput> | TOutput
  /** 是否需要权限确认。 */
  requirePermission?: boolean
  /** 是否在 UI 中显示结果。 */
  displayResult?: boolean
}

/**
 * 定义一个工具。
 *
 * 定义的工具会自动注册到 Cordis Tools Service（如果可用），
 * 也可以被 Agent Loop 调用。
 */
export function defineTool<TInput = any, TOutput = any>(
  def: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  // 如果 Cordis Context 已初始化，自动注册
  const ctx = tryGetCtx()
  if (ctx) {
    const tools = ctx.get('tools')
    if (tools) {
      tools.register(def)
    }
  }
  return def
}

/**
 * 定义一个 Cordis 插件形式的工具包。
 *
 * 工具以 Cordis 插件形式注册，拥有完整的生命周期管理。
 * 当插件卸载时，工具自动注销。
 */
export function defineToolPlugin(
  tools: ToolDefinition[]
): import('../cordis/src/index.ts').Plugin {
  return (ctx: Context) => {
    const toolsService = ctx.get('tools')
    if (!toolsService) {
      throw new Error('Tools service not available. Inject "tools" in your plugin config.')
    }
    const disposers = tools.map((tool) => toolsService.register(tool))
    return () => {
      disposers.forEach((dispose) => dispose())
    }
  }
}

/**
 * 通过 Cordis Context 调用 LLM。
 * 工具内部使用，避免直接 import ProviderRegistry。
 * 带重试等待：如果 fiber 尚未 ACTIVE，会重试几次。
 */
export async function callLLM(request: any): Promise<any> {
  const ctx = useCtx()
  let llm: any = ctx.get('llm')
  if (!llm) {
    // fiber 可能尚未 ACTIVE，重试等待
    llm = await getServiceAsync('llm')
    if (!llm) throw new Error('LLM service not available after retries')
  }
  return llm.complete(request)
}

/**
 * 通过 Cordis Context 调用另一个工具。
 */
export async function callTool(name: string, input: any): Promise<any> {
  const ctx = useCtx()
  let tools: any = ctx.get('tools')
  if (!tools) {
    tools = await getServiceAsync('tools')
    if (!tools) throw new Error('Tools service not available after retries')
  }
  return tools.execute(name, input)
}

/**
 * 通过 Cordis Context 获取当前会话。
 */
export function getCurrentSession(): any {
  const ctx = useCtx()
  const session = ctx.get('session')
  if (!session) throw new Error('Session service not available')
  return session.getCurrent()
}

/**
 * 通过 Cordis Context 读取/写入设置。
 */
export function getSetting<T>(key: string, defaultValue?: T): T {
  const ctx = useCtx()
  const settings = ctx.get('settings')
  if (!settings) return defaultValue as T
  return settings.get(key, defaultValue)
}

export function setSetting<T>(key: string, value: T): void {
  const ctx = useCtx()
  const settings = ctx.get('settings')
  if (!settings) return
  settings.set(key, value)
}

/**
 * 通过 Cordis Context 检查权限。
 */
export function checkPermission(action: string, resource?: any): boolean {
  const ctx = useCtx()
  const perm = ctx.get('permission')
  if (!perm) return true // 无权限服务时默认放行
  return perm.check(action, resource)
}

/**
 * 通过 Cordis Context 记录到内存。
 */
export function addToMemory(entry: any): void {
  const ctx = useCtx()
  const memory = ctx.get('memory')
  if (!memory) return
  memory.add(entry)
}
