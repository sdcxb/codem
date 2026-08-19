/**
 * D5/D8-3: Cordis Context 类型声明 — 对标 DSH 的 `declare module` 模式
 *
 * DSH 参考: packages/client/web/src/app-shell.ts
 *   declare module '@deepseek-ai/cordis' {
 *     interface Context {
 *       appShell: AppShellService
 *     }
 *   }
 *
 * 本文件为所有 Provider 声明 Context 扩展，使 ctx.get('xxx') 类型安全。
 */

import type { Message, ToolCall } from '../../store'
import type { StoredEntry } from '../slots/index'

// ============================================================
//  LLM Engine
// ============================================================
export interface LLMEngineService {
  _active: boolean
  updateConfig(config: { defaultProvider?: string; defaultModel?: string }): void
  setProviderConfig(provider: string, config: { apiKey: string; baseUrl?: string }): void
  getDefaultProvider(): string
  getDefaultModel(): string
  providers: Map<string, any>
  abort(): void
  chat(params: { messages: any[]; model?: string; provider?: string; signal?: AbortSignal }): Promise<any>
  process(...args: any[]): AsyncIterable<any>
  buildSystemPrompt(...args: any[]): string
  sendGuidance(sessionId: string, message: string): boolean
  setMemoryEnabled(sessionId: string, enabled: boolean): void
  isMemoryEnabled(sessionId: string): boolean
  getMemoryConsolidationStats(sessionId: string): any
  consolidateMemories(sessionId: string): Promise<any>
  context: any
  tools: any
  agents: any
  permissions: any
  [key: string]: any
}

// ============================================================
//  MiMo Auth
// ============================================================
export interface MiMoAuthService {
  _active: boolean
  getActiveAccount(): { accessToken: string; url: string } | null
  loadFromAuthJson(): Promise<{ accessToken: string; url: string } | null>
}

// ============================================================
//  Agent Registry
// ============================================================
export interface AgentRegistryService {
  _active: boolean
  getPrimary(): Array<{ id: string; name: string; description: string; collaborationMode?: string }>
  get(id: string): { id: string; name: string; collaborationMode?: string } | null
}

// ============================================================
//  Credentials
// ============================================================
export interface CredentialsService {
  _active: boolean
  get(provider: string): string | null
  set(provider: string, key: string): void
  delete(provider: string): void
}

// ============================================================
//  Guard
// ============================================================
export interface GuardService {
  _active: boolean
  checkRepeat(toolName: string, args: any): { isRepeat: boolean; message?: string }
  setDeadline(sessionId: string, maxIterations: number): void
  checkDeadline(sessionId: string): { exceeded: boolean; remaining: number }
}

// ============================================================
//  Sandbox
// ============================================================
export interface SandboxService {
  _active: boolean
  execute(code: string, timeout?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

// ============================================================
//  Hooks
// ============================================================
export interface HooksService {
  _active: boolean
  register(event: string, handler: any, options?: { timeout?: number }): void
  unregister(event: string, handlerId: string): void
  executeHooks(event: string, payload: any): Promise<any[]>
  listHooks(event?: string): any[]
  clearAllHooks(): void
}

// ============================================================
//  Automation
// ============================================================
export interface AutomationService {
  _active: boolean
  registerTrigger(config: { type: string; [key: string]: any }): string
  removeTrigger(triggerId: string): void
  listTriggers(): Array<{ id: string; type: string; config: any }>
  start(onTrigger: (trigger: any) => void): void
  stop(): void
  refresh(): void
}

// ============================================================
//  Slots
// ============================================================
export interface SlotsService {
  install(renderer: any): void
  subscribe(key: string, onChange: () => void): () => void
  entriesOfSlot(key: string): StoredEntry[]
}

// ============================================================
//  Attachments
// ============================================================
export interface AttachmentsService {
  _active: boolean
  store(content: string | Uint8Array): Promise<string>
  retrieve(hash: string): Promise<string | Uint8Array | null>
}

// ============================================================
//  Schedule
// ============================================================
export interface ScheduleService {
  _active: boolean
  add(reminder: { time: number; message: string }): string
  remove(id: string): void
}

// ============================================================
//  Context Info
// ============================================================
export interface ContextInfoService {
  _active: boolean
  collect(): { cwd: string; platform: string; [key: string]: any }
}

// ============================================================
//  Commands
// ============================================================
export interface CommandsService {
  _active: boolean
  register(id: string, handler: () => void): void
  unregister(id: string): void
  list(): Array<{ id: string; description: string }>
  execute(id: string): void
}

// ============================================================
//  Repeat Tool Reminder
// ============================================================
export interface RepeatToolReminderService {
  _active: boolean
  record(sessionId: string, toolName: string, args: string): void
  check(sessionId: string): { isRepeat: boolean; message?: string }
}

// ============================================================
//  Timeout Guard
// ============================================================
export interface TimeoutGuardService {
  _active: boolean
  wrap<T>(promise: Promise<T>, ms: number): Promise<T>
}

// ============================================================
//  Invariants Guard
// ============================================================
export interface InvariantsGuardService {
  _active: boolean
  check(state: any): { passed: boolean; violations: string[] }
}

// ============================================================
//  Context 扩展声明 — 对标 DSH declare module 模式
// ============================================================
declare module '../cordis/src/context' {
  interface Context {
    llmEngine?: LLMEngineService
    mimoAuth?: MiMoAuthService
    agentRegistry?: AgentRegistryService
    credentials?: CredentialsService
    guard?: GuardService
    sandbox: SandboxService
    hooks: HooksService
    automation: AutomationService
    // slots 声明由 src/core/slots/index.ts 中的 SlotsService class 提供
    modelProfile?: any
    attachments?: AttachmentsService
    schedule?: ScheduleService
    contextInfo?: ContextInfoService
    commands?: CommandsService
    repeatToolReminder?: RepeatToolReminderService
    timeoutGuard?: TimeoutGuardService
    invariantsGuard?: InvariantsGuardService
  }
}
