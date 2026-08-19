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

/** 当前活跃的 Cordis Context（由 App.tsx 初始化时设置）。 */
let _activeCtx: Context | null = null

/**
 * 设置活跃的 Cordis Context。
 * 在 App.tsx 的 getCordisContext() 中调用。
 */
export function setActiveContext(ctx: Context) {
  _activeCtx = ctx
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
 */
export async function callLLM(request: any): Promise<any> {
  const ctx = useCtx()
  const llm = ctx.get('llm')
  if (!llm) throw new Error('LLM service not available')
  return llm.complete(request)
}

/**
 * 通过 Cordis Context 调用另一个工具。
 */
export async function callTool(name: string, input: any): Promise<any> {
  const ctx = useCtx()
  const tools = ctx.get('tools')
  if (!tools) throw new Error('Tools service not available')
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
