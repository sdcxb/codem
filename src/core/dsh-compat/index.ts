// @ts-nocheck
/**
 * dsh-compat — DeepSeek Harness 接口兼容适配层（懒解析别名）。
 *
 * 将 Codem 的服务接口适配为 dsh 标准接口签名，使按 dsh 协议编写、无第三方
 * 依赖的插件（插件市场"可适配"类）可以经这些别名消费 Codem 服务：
 *
 *   1. dshLlm    ← llm    （GenerateOptions/StreamChunk ↔ Codem request/stream）
 *   2. dshShell  ← shell  （resolve/start/run/sandboxMode ↔ execute）
 *   3. dshFs     ← fs     （readFile/writeFile/listDirectory/stat/rm）
 *   4. dshTools  ← tools  （execute({callId,name,arguments}) ↔ execute(name,args)）
 *   5. dshSessions← session（create/get/list/remove）
 *   6. dshEvents ← ctx    （emit/on/waterfall/serial/bail/parallel）
 *   7. dshCredentials ← settings（provider apiKey 读取）
 *
 * 2026-09 审计修复：原实现把 `ctx.get('llm')` 等放在 apply 阶段并据此决定是否
 * 注册别名 —— 服务未就绪时别名缺失（时序竞态，实际一直未接入）。改为
 * **懒解析代理**：别名恒注册，方法调用时才 `ctx.get(realService)`，任何时刻可用。
 *
 * 插件市场条目（dsh-market-catalog 的 adaptable）即通过本层接入。
 *
 * 2026-09 服务名对齐矩阵（对 harness packages 全量插件 inject 服务名 78 项
 * 与 Codem provides 203 项逐项比对后的结论，作为后续审计基准）：
 *   - **核心 seam 同名直通**（dsh 能力/工具插件的主要依赖，Codem 同名提供）：
 *     fs / shell / tools / llm / session / credentials / sandboxPolicy / slots /
 *     subprocess / commands / compaction / systemPrompt / userQuestions / web /
 *     dynamicCordisRunner / subagent（=dsh subagents 单数）…；
 *   - **复数/命名差异经别名承接**：sessions→session（+事件日志）、
 *     sessionProjections→sessionProjection、sessionQuery→sessionQuerySqlite、
 *     sessionTitle→sessionTitleLLM、goals→goalRoundDriver、bash→shell 等——
 *     即本文件 7 个别名 + Cordis 注入点覆盖；
 *   - **harness 宿主装配名不适用**（约 30 项：remote.* / uiConversation /
 *     uiSession / uiWorkspace / typert / typertGateway / webServer / cmdlineArgs /
 *     connection / clientModules / loader / modules / layout / inputTriggers /
 *     commandUi / settingsSchema / settingsScope / shellEnv / agentTeams /
 *     subagentModelSelection / workflowEngine / jobs / terminals / workspaces /
 *     webhookRuntime / invariants 等）：属 harness 桌面/宿主编排层（服务端进程、
 *     RPC 网关、窗口 UI 槽），消费它们的插件是宿主插件而非纯协议插件——
 *     超出"可适配"范围，市场目录如实标 unsupported。
 *   结论：能力/工具类 dsh 插件的核心依赖与 Codem 服务名同构，
 *   适配成本集中在单复数/命名别名，无协议级鸿沟。
 */

import type { Plugin } from '../cordis/src/index.ts'
import type { GenerateOptions, StreamChunk, Message } from './dsh-types'

/** 懒解析代理：把别名方法绑定到"调用时从 ctx 现取的真实服务"上。 */
function alias(ctx: any, realName: string, build: (real: any) => any): any {
  const resolve = (): any => {
    const real = ctx.get(realName)
    if (!real) throw new Error(`[dsh-compat] service "${realName}" not ready`)
    return build(real)
  }
  return new Proxy({}, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined
      if (prop === '__dshReal') return () => resolve()
      const svc = resolve()
      const value = svc[prop]
      return typeof value === 'function' ? value.bind(svc) : value
    },
    set() { return false },
    has() { return true },
  })
}

function buildLlm(realLlm: any) {
  return {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const codemRequest = {
        provider: options.provider,
        model: options.model,
        messages: options.messages?.map((m: Message) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })) || [],
        system: options.system,
        tools: options.tools,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stop: options.stop,
      }
      for await (const chunk of realLlm.stream(codemRequest)) {
        yield { type: 'content', delta: typeof chunk === 'string' ? chunk : chunk?.content || chunk?.delta || '' }
      }
    },
    async generate(options: GenerateOptions): Promise<{ content: string; role: 'assistant' }> {
      const codemRequest = {
        provider: options.provider,
        model: options.model,
        messages: options.messages?.map((m: Message) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })) || [],
        system: options.system,
      }
      const result = await realLlm.complete(codemRequest)
      return { content: typeof result === 'string' ? result : result?.content || '', role: 'assistant' }
    },
    async listProviders() {
      const models = await realLlm.listModels()
      const providers = new Set(models.map((m: any) => m.provider || 'mimo'))
      return [...providers].map((id: string) => ({ id, label: id }))
    },
    async listModels(provider?: string) {
      const models = await realLlm.listModels()
      return models.filter((m: any) => !provider || m.provider === provider).map((m: any) => ({ id: m.id || m.name, provider: m.provider || 'mimo' }))
    },
  }
}

function buildShell(realShell: any) {
  const toResult = (r: any) => ({ stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode ?? 0, ok: (r.exitCode ?? 0) === 0 })
  return {
    sandboxMode: undefined as string | undefined,
    resolve(request: any): any {
      return { command: request.command, workdir: request.workdir || request.cwd || '.', timeoutMs: request.timeoutMs || 30000 }
    },
    async run(spec: any) {
      return toResult(await realShell.execute(spec.command, spec.workdir, spec.timeoutMs))
    },
    start(spec: any) {
      const proc = {
        id: crypto.randomUUID(),
        spec,
        done: false,
        async wait() {
          proc.done = true
          return toResult(await realShell.execute(spec.command, spec.workdir, spec.timeoutMs))
        },
        kill() { /* best effort */ },
      }
      return proc
    },
  }
}

function buildFs(realFs: any) {
  return {
    async readFile(path: string) { return realFs.readFile(path) },
    async writeFile(path: string, content: string) { return realFs.writeFile(path, content) },
    async listDirectory(path: string) { return realFs.listDirectory(path) },
    async stat(path: string) {
      const exists = await realFs.exists(path)
      return { exists, isDirectory: false, size: 0 }
    },
    async rm(path: string) { return realFs.deleteFile(path) },
  }
}

function buildTools(realTools: any) {
  return {
    async execute(call: { callId?: string; name: string; arguments?: any; signal?: AbortSignal }) {
      return realTools.execute(call.name, call.arguments || {})
    },
    list() {
      return realTools.list().map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    },
    get(name: string) {
      const t = realTools.get(name)
      return t ? { name: t.name, description: t.description, inputSchema: t.inputSchema } : undefined
    },
  }
}

function buildSessions(realSession: any) {
  return {
    create(config?: any) { return realSession.create(config) },
    get(id: string) { return realSession.get(id) },
    list() { return realSession.list() },
    remove(id: string) { realSession.delete(id) },
  }
}

function buildCredentials(ctx: any) {
  return {
    async get(provider: string) {
      try {
        const settings = ctx.get('settings') as any
        const all = settings?.getAll?.() || {}
        const providers = all.providers || []
        const p = providers.find((x: any) => x.id === provider)
        return p?.apiKey
      } catch { return undefined }
    },
    async set(provider: string, key: string) {
      const settings = ctx.get('settings') as any
      settings?.set?.(`credential:${provider}`, key)
    },
  }
}

/**
 * dsh 兼容适配插件：懒注册 dsh 标准接口别名（dshLlm/dshShell/dshFs/…）。
 * 任何时刻可用（方法调用时才解析真实服务），可安全接入主装配。
 */
export const dshCompatPlugin: Plugin = (ctx: any) => {
  const disposers: Array<() => void> = []

  disposers.push(ctx.provide('dshLlm', alias(ctx, 'llm', buildLlm)))
  disposers.push(ctx.provide('dshShell', alias(ctx, 'shell', buildShell)))
  disposers.push(ctx.provide('dshFs', alias(ctx, 'fs', buildFs)))
  disposers.push(ctx.provide('dshTools', alias(ctx, 'tools', buildTools)))
  disposers.push(ctx.provide('dshSessions', alias(ctx, 'session', buildSessions)))
  disposers.push(ctx.provide('dshCredentials', buildCredentials(ctx)))

  // dshEvents 直接代理到 Cordis 事件系统（非懒——ctx 本身即事件宿主）
  disposers.push(ctx.provide('dshEvents', {
    emit(event: string, ...args: any[]) { ctx.emit(event, ...args) },
    on(event: string, handler: (...args: any[]) => void) { return ctx.on(event, handler) },
    waterfall(event: string, ...args: any[]) { return ctx.waterfall(event, ...args) },
    serial(event: string, ...args: any[]) { return ctx.serial(event, ...args) },
    bail(event: string, ...args: any[]) { return ctx.bail(event, ...args) },
    parallel(event: string, ...args: any[]) { return ctx.parallel(event, ...args) },
  }))

  console.log('[dsh-compat] dsh compatibility layer loaded (lazy aliases)')
  return () => disposers.forEach((d) => d())
}

/**
 * dsh 兼容接口声明 — 扩展 Context 类型。
 */
declare module '../cordis/src/context.ts' {
  interface Context {
    dshLlm?: any
    dshShell?: any
    dshFs?: any
    dshTools?: any
    dshSessions?: any
    dshEvents?: any
    dshCredentials?: any
  }
}
