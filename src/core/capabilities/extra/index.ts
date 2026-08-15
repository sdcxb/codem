// @ts-nocheck
/**
 * P6.2 剩余后端能力插件化
 *
 * 新建能力族：identity/guard/LSP/code-runtime/workflow/context/
 * preset/bundle/sdk/acp/notebook/squad/commands/user-questions
 */
import type { Context, Plugin } from '../cordis/src/index.ts'

// ========== 身份能力族 ==========
export interface Identity {
  getId(): string
  getName(): string
  getAvatar?(): string
}

export class AnonymousIdentity implements Identity {
  private id = crypto.randomUUID()
  getId() { return this.id }
  getName() { return 'Anonymous' }
}

declare module '../cordis/src/context.ts' {
  interface Context { identity: Identity }
}

// ========== Guard 能力族 ==========
export interface Guard {
  /** 检查是否重复调用 */
  checkRepeat(toolName: string, args: any): { isRepeat: boolean; message?: string }
  /** 检查截止时间 */
  checkDeadline(sessionId: string): { exceeded: boolean; remaining?: number }
}

export class DefaultGuard implements Guard {
  private callHistory = new Map<string, { tool: string; args: string; time: number }[]>()

  checkRepeat(toolName: string, args: any): { isRepeat: boolean; message?: string } {
    const key = 'global'
    const argStr = JSON.stringify(args)
    const now = Date.now()
    const history = this.callHistory.get(key) || []

    const recent = history.filter(h => h.tool === toolName && h.args === argStr && now - h.time < 5000)
    if (recent.length > 0) {
      return { isRepeat: true, message: `Tool "${toolName}" was called with the same args recently` }
    }

    history.push({ tool: toolName, args: argStr, time: now })
    if (history.length > 100) history.shift()
    this.callHistory.set(key, history)
    return { isRepeat: false }
  }

  checkDeadline(sessionId: string): { exceeded: boolean; remaining?: number } {
    // 默认无截止时间
    return { exceeded: false }
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { guard: Guard }
}

// ========== LSP 能力族 ==========
export interface LSP {
  start(workspace: string): Promise<string>
  stop(serverId: string): Promise<void>
  getDiagnostics(file: string): Promise<Array<{ line: number; col: number; severity: string; message: string }>>
  hover(file: string, line: number, col: number): Promise<string | null>
  completions(file: string, line: number, col: number): Promise<any[]>
}

export class StdioLSP implements LSP {
  private servers = new Map<string, { id: string; workspace: string }>()

  async start(workspace: string): Promise<string> {
    const id = crypto.randomUUID()
    this.servers.set(id, { id, workspace })
    return id
  }
  async stop(serverId: string): Promise<void> {
    this.servers.delete(serverId)
  }
  async getDiagnostics(_file: string) { return [] }
  async hover(_file: string, _line: number, _col: number) { return null }
  async completions(_file: string, _line: number, _col: number) { return [] }
}

declare module '../cordis/src/context.ts' {
  interface Context { lsp: LSP }
}

// ========== 代码执行能力族 ==========
export interface CodeRuntime {
  execute(code: string, language: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export class WorkerCodeRuntime implements CodeRuntime {
  async execute(code: string, language: string, cwd?: string) {
    // 在 Worker 中执行代码
    try {
      const blob = new Blob([code], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      const worker = new Worker(url)
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        let stdout = ''
        worker.onmessage = (e) => { stdout += e.data }
        worker.onerror = (e) => resolve({ stdout, stderr: e.message, exitCode: 1 })
        setTimeout(() => {
          worker.terminate()
          resolve({ stdout, stderr: '', exitCode: 0 })
        }, 30000)
      })
    } catch (err: any) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { codeRuntime: CodeRuntime }
}

// ========== 工作流能力族 ==========
export interface Workflow {
  create(steps: Array<{ name: string; fn: () => Promise<any> }>): string
  run(workflowId: string): Promise<{ success: boolean; results: any[] }>
  get(workflowId: string): { id: string; status: string; step: number } | undefined
}

export class WorkerWorkflow implements Workflow {
  private workflows = new Map<string, { id: string; steps: any[]; status: string; step: number; results: any[] }>()

  create(steps: Array<{ name: string; fn: () => Promise<any> }>): string {
    const id = crypto.randomUUID()
    this.workflows.set(id, { id, steps, status: 'pending', step: 0, results: [] })
    return id
  }

  async run(workflowId: string): Promise<{ success: boolean; results: any[] }> {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { success: false, results: [] }

    wf.status = 'running'
    for (let i = 0; i < wf.steps.length; i++) {
      wf.step = i
      try {
        const result = await wf.steps[i].fn()
        wf.results.push(result)
      } catch (err) {
        wf.status = 'failed'
        return { success: false, results: wf.results }
      }
    }
    wf.status = 'completed'
    return { success: true, results: wf.results }
  }

  get(workflowId: string) {
    const wf = this.workflows.get(workflowId)
    return wf ? { id: wf.id, status: wf.status, step: wf.step } : undefined
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { workflow: Workflow }
}

// ========== 上下文能力族 ==========
export interface ContextService {
  getInstructions(): string
  getTime(): string
  getWorkspace(): string
  assemble(): string
}

export class DefaultContext implements ContextService {
  getInstructions() { return 'You are a helpful AI coding assistant.' }
  getTime() { return new Date().toISOString() }
  getWorkspace() { return '/' }
  assemble() {
    return `${this.getInstructions()}\n\nCurrent time: ${this.getTime()}\nWorkspace: ${this.getWorkspace()}`
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { contextInfo: ContextService }
}

// ========== 命令能力族 ==========
export interface Commands {
  register(name: string, handler: (args: any) => any, description?: string): void
  execute(name: string, args?: any): any
  list(): Array<{ name: string; description?: string }>
}

export class DefaultCommands implements Commands {
  private commands = new Map<string, { handler: (args: any) => any; description?: string }>()

  register(name: string, handler: (args: any) => any, description?: string): void {
    this.commands.set(name, { handler, description })
  }
  execute(name: string, args?: any): any {
    const cmd = this.commands.get(name)
    return cmd?.handler(args)
  }
  list(): Array<{ name: string; description?: string }> {
    return [...this.commands.entries()].map(([name, { description }]) => ({ name, description }))
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { commands: Commands }
}

// ========== 用户问题能力族 ==========
export interface UserQuestions {
  ask(question: string, options?: string[]): Promise<string>
  getPending(): Array<{ id: string; question: string; options?: string[] }>
  answer(id: string, answer: string): void
}

export class DefaultUserQuestions implements UserQuestions {
  private pending: Array<{ id: string; question: string; options?: string[]; resolve: (a: string) => void }> = []

  async ask(question: string, options?: string[]): Promise<string> {
    const id = crypto.randomUUID()
    return new Promise(resolve => {
      this.pending.push({ id, question, options, resolve })
    })
  }

  getPending() {
    return this.pending.map(({ id, question, options }) => ({ id, question, options }))
  }

  answer(id: string, answer: string): void {
    const idx = this.pending.findIndex(p => p.id === id)
    if (idx >= 0) {
      this.pending[idx].resolve(answer)
      this.pending.splice(idx, 1)
    }
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { userQuestions: UserQuestions }
}

// ========== Notebook 能力族 ==========
export interface Notebook {
  create(title: string): string
  addEntry(notebookId: string, content: string): void
  get(notebookId: string): { id: string; title: string; entries: string[] } | undefined
  list(): Array<{ id: string; title: string }>
  remove(notebookId: string): void
}

export class DefaultNotebook implements Notebook {
  private notebooks = new Map<string, { id: string; title: string; entries: string[] }>()

  create(title: string): string {
    const id = crypto.randomUUID()
    this.notebooks.set(id, { id, title, entries: [] })
    return id
  }
  addEntry(notebookId: string, content: string): void {
    const nb = this.notebooks.get(notebookId)
    if (nb) nb.entries.push(content)
  }
  get(notebookId: string) { return this.notebooks.get(notebookId) }
  list() { return [...this.notebooks.values()].map(({ id, title }) => ({ id, title })) }
  remove(notebookId: string): void { this.notebooks.delete(notebookId) }
}

declare module '../cordis/src/context.ts' {
  interface Context { notebook: Notebook }
}

// ========== Squad 能力族 ==========
export interface Squad {
  create(name: string, members: string[]): string
  get(squadId: string): { id: string; name: string; members: string[] } | undefined
  list(): Array<{ id: string; name: string; memberCount: number }>
  addMember(squadId: string, member: string): void
  removeMember(squadId: string, member: string): void
  disband(squadId: string): void
}

export class DefaultSquad implements Squad {
  private squads = new Map<string, { id: string; name: string; members: string[] }>()

  create(name: string, members: string[]): string {
    const id = crypto.randomUUID()
    this.squads.set(id, { id, name, members })
    return id
  }
  get(squadId: string) { return this.squads.get(squadId) }
  list() { return [...this.squads.values()].map(s => ({ id: s.id, name: s.name, memberCount: s.members.length })) }
  addMember(squadId: string, member: string): void {
    const s = this.squads.get(squadId)
    if (s && !s.members.includes(member)) s.members.push(member)
  }
  removeMember(squadId: string, member: string): void {
    const s = this.squads.get(squadId)
    if (s) s.members = s.members.filter(m => m !== member)
  }
  disband(squadId: string): void { this.squads.delete(squadId) }
}

declare module '../cordis/src/context.ts' {
  interface Context { squad: Squad }
}

// ========== 插件定义 ==========
export const inject = [] as const
export const provide = [
  'identity', 'guard', 'lsp', 'codeRuntime', 'workflow',
  'contextInfo', 'commands', 'userQuestions', 'notebook', 'squad'
] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('identity', new AnonymousIdentity())
  ctx.provide('guard', new DefaultGuard())
  ctx.provide('lsp', new StdioLSP())
  ctx.provide('codeRuntime', new WorkerCodeRuntime())
  ctx.provide('workflow', new WorkerWorkflow())
  ctx.provide('contextInfo', new DefaultContext())
  ctx.provide('commands', new DefaultCommands())
  ctx.provide('userQuestions', new DefaultUserQuestions())
  ctx.provide('notebook', new DefaultNotebook())
  ctx.provide('squad', new DefaultSquad())
}
