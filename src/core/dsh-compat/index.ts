// @ts-nocheck
/**
 * dsh-compat — DeepSeek Harness 接口兼容适配层。
 *
 * 将 Codem 的服务接口适配为 dsh 标准接口签名，
 * 使 dsh 插件可以直接在 Codem 运行时中加载和运行。
 *
 * 适配的核心接口：
 * 1. LLM: dsh 使用 GenerateOptions + StreamChunk，我们使用 request + response
 * 2. Shell: dsh 使用 ctx.shell.resolve/start/run/sandboxMode，我们使用 execute(command, cwd)
 * 3. FileSystem: dsh 使用路径式 API，我们使用 Tauri invoke
 * 4. Tools: dsh 使用 ctx.tools.execute(CallId, name, arguments)，我们使用 execute(name, input)
 * 5. Session: dsh 使用 ctx.sessions (SessionStore)，我们使用 ctx.session
 * 6. Events: dsh 使用 waterfall/emit 模式，我们使用简单的 emit
 */

import type { Context, Plugin } from '../cordis/src/index.ts'
import type { GenerateOptions, StreamChunk, Message } from './dsh-types'

/**
 * dsh 兼容适配插件。
 *
 * 加载此插件后，Codem Context 上会注册 dsh 标准的接口别名，
 * 使 dsh 插件可以通过标准接口消费 Codem 服务。
 *
 * 使用方式：
 * ```typescript
 * import { dshCompatPlugin } from './dsh-compat'
 * ctx.plugin(dshCompatPlugin)
 * // 现在 dsh 插件可以使用 ctx.llm.stream(options) 等 dsh 标准接口
 * ```
 */
export const dshCompatPlugin: Plugin = (ctx: any) => {
  const disposers: Array<() => void> = []

  // ===== 1. LLM 适配 =====
  // dsh 的 LLM 接口使用 GenerateOptions 和 StreamChunk
  // 我们将 dsh 的调用转换为 Codem 的 complete/stream 调用
  const originalLlm = ctx.llm
  if (originalLlm) {
    // 在 ctx 上注册 dsh 标准的 LLM 接口
    disposers.push(ctx.provide('dshLlm', {
      /**
       * dsh 标准流式生成接口。
       * 将 GenerateOptions 转换为 Codem 的 request 格式。
       */
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        // 转换 messages: dsh Message[] → Codem 格式
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

        // 调用 Codem 的 stream
        for await (const chunk of originalLlm.stream(codemRequest)) {
          // 将 Codem 的 chunk 转换为 dsh StreamChunk
          yield {
            type: 'content',
            delta: typeof chunk === 'string' ? chunk : chunk?.content || chunk?.delta || '',
          }
        }
      },

      /**
       * dsh 标准非流式生成接口。
       */
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
        const result = await originalLlm.complete(codemRequest)
        return {
          content: typeof result === 'string' ? result : result?.content || '',
          role: 'assistant',
        }
      },

      listProviders: async () => {
        const models = await originalLlm.listModels()
        const providers = new Set(models.map((m: any) => m.provider || 'mimo'))
        return [...providers].map((id: string) => ({ id, label: id }))
      },

      listModels: async (provider?: string) => {
        const models = await originalLlm.listModels()
        return models
          .filter((m: any) => !provider || m.provider === provider)
          .map((m: any) => ({ id: m.id || m.name, provider: m.provider || 'mimo' }))
      },
    }))
  }

  // ===== 2. Shell 适配 =====
  // dsh 的 Shell 接口使用 resolve/start/run/sandboxMode
  const originalShell = ctx.shell
  if (originalShell) {
    disposers.push(ctx.provide('dshShell', {
      sandboxMode: undefined as string | undefined,

      resolve(request: any): any {
        return {
          command: request.command,
          workdir: request.workdir || request.cwd || '.',
          timeoutMs: request.timeoutMs || 30000,
        }
      },

      async run(spec: any): Promise<any> {
        const result = await originalShell.execute(spec.command, spec.workdir, spec.timeoutMs)
        return {
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: result.exitCode ?? 0,
          ok: (result.exitCode ?? 0) === 0,
        }
      },

      start(spec: any): any {
        // 返回一个类似 dsh 的 process handle
        const proc = {
          id: crypto.randomUUID(),
          spec,
          done: false,
          async wait(): Promise<any> {
            const result = await originalShell.execute(spec.command, spec.workdir, spec.timeoutMs)
            proc.done = true
            return {
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              exitCode: result.exitCode ?? 0,
              ok: (result.exitCode ?? 0) === 0,
            }
          },
          kill() { /* best effort */ },
        }
        return proc
      },
    }))
  }

  // ===== 3. FileSystem 适配 =====
  // dsh 的 FS 接口使用 path-based API，与我们的类似
  const originalFs = ctx.fs
  if (originalFs) {
    disposers.push(ctx.provide('dshFs', {
      async readFile(path: string): Promise<string> {
        return originalFs.readFile(path)
      },
      async writeFile(path: string, content: string): Promise<void> {
        return originalFs.writeFile(path, content)
      },
      async listDirectory(path: string): Promise<any[]> {
        return originalFs.listDirectory(path)
      },
      async stat(path: string): Promise<{ exists: boolean; isDirectory: boolean; size: number }> {
        const exists = await originalFs.exists(path)
        return { exists, isDirectory: false, size: 0 }
      },
      async rm(path: string): Promise<void> {
        return originalFs.deleteFile(path)
      },
    }))
  }

  // ===== 4. Tools 适配 =====
  // dsh 的 Tools 接口使用 execute({ callId, name, arguments })
  const originalTools = ctx.tools
  if (originalTools) {
    disposers.push(ctx.provide('dshTools', {
      async execute(call: { callId?: string; name: string; arguments?: any; signal?: AbortSignal }): Promise<any> {
        return originalTools.execute(call.name, call.arguments || {})
      },
      list(): any[] {
        return originalTools.list().map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
      },
      get(name: string): any {
        const t = originalTools.get(name)
        return t ? { name: t.name, description: t.description, inputSchema: t.inputSchema } : undefined
      },
    }))
  }

  // ===== 5. Session 适配 =====
  // dsh 使用 ctx.sessions (SessionStore)，我们使用 ctx.session
  const originalSession = ctx.session
  if (originalSession) {
    disposers.push(ctx.provide('dshSessions', {
      create(config?: any) { return originalSession.create(config) },
      get(id: string) { return originalSession.get(id) },
      list() { return originalSession.list() },
      remove(id: string) { originalSession.delete(id) },
    }))
  }

  // ===== 6. Events 适配 =====
  // dsh 使用 waterfall/emit 模式
  // 我们的 Cordis 已经有 emit，只需确保兼容
  disposers.push(ctx.provide('dshEvents', {
    emit(event: string, ...args: any[]): void {
      ctx.emit(event, ...args)
    },
    on(event: string, handler: (...args: any[]) => void): () => void {
      return ctx.on(event, handler)
    },
    async waterfall(event: string, ...args: any[]): Promise<any[]> {
      // 简单实现：顺序调用所有监听器
      const results: any[] = []
      // Cordis 的 on() 返回 disposer，我们无法直接获取所有监听器
      // 这是简化实现
      ctx.emit(event, ...args)
      return results
    },
  }))

  // ===== 7. Settings 适配 =====
  // dsh 使用 ctx.settings，我们也有 ctx.settings
  // 接口兼容，无需额外适配

  // ===== 8. Credential 适配 =====
  // dsh 使用 ctx.credentials，我们没有对应的 credential service
  disposers.push(ctx.provide('dshCredentials', {
    async get(provider: string): Promise<string | undefined> {
      try {
        const settings = ctx.settings?.getAll?.() || {}
        const providers = settings.providers || []
        const p = providers.find((p: any) => p.id === provider)
        return p?.apiKey
      } catch { return undefined }
    },
    async set(provider: string, key: string): Promise<void> {
      // 委托给 settings
      ctx.settings?.set?.(`credential:${provider}`, key)
    },
  }))

  console.log('[dsh-compat] dsh compatibility layer loaded')
  return () => disposers.forEach(d => d())
}

/**
 * dsh 兼容接口声明 — 扩展 Context 类型。
 */
declare module '../cordis/src/context.ts' {
  interface Context {
    /** dsh 兼容 LLM 接口 */
    dshLlm?: any
    /** dsh 兼容 Shell 接口 */
    dshShell?: any
    /** dsh 兼容 FS 接口 */
    dshFs?: any
    /** dsh 兼容 Tools 接口 */
    dshTools?: any
    /** dsh 兼容 Sessions 接口 */
    dshSessions?: any
    /** dsh 兼容 Events 接口 */
    dshEvents?: any
    /** dsh 兼容 Credentials 接口 */
    dshCredentials?: any
  }
}
