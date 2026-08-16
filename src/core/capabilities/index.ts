// @ts-nocheck
/**
 * Codem 能力族定义 (Capability Seam Definitions)。
 *
 * R3-Audit: This directory contains Service Definition interfaces (Cordis declarations).
 * The canonical implementations are in src/core/provider/ — this directory is kept
 * for interface definitions only. The local.ts files in subdirectories are legacy
 * wrappers that delegate to provider/ implementations.
 *
 * 三层架构：
 * 1. Service Definition (本文件) — 纯接口契约
 * 2. Provider (src/core/provider/) — 默认实现 ← CANONICAL
 * 3. Consumer (src/core/consumer/) — 工具消费层
 *
 * 新代码应直接从 src/core/provider/ 导入。
 */

import type { Context, Service } from '../cordis/src/index.ts'

// ==================== 1. LLM Provider ====================
export interface LLMProviderService {
  complete(request: any): Promise<any>
  stream(request: any): AsyncIterable<any>
  listModels(): Promise<any[]>
  isConfigured(): boolean
}
export class LLMProviderDef extends Service {}
declare module '../cordis/src/context.ts' {
  interface Context { llm: LLMProviderService }
}

// ==================== 2. Tools ====================
export interface ToolsService {
  register(definition: any): () => void
  execute(name: string, input: any): Promise<any>
  list(): any[]
  get(name: string): any | undefined
}
declare module '../cordis/src/context.ts' {
  interface Context { tools: ToolsService }
}

// ==================== 3. Agent Loop ====================
export interface AgentLoopService {
  run(sessionId: string, config?: any): Promise<any>
  stop(sessionId: string): void
  getState(sessionId: string): any
}
declare module '../cordis/src/context.ts' {
  interface Context { agentLoop: AgentLoopService }
}

// ==================== 4. Session ====================
export interface SessionService {
  create(config?: any): any
  get(id: string): any | undefined
  list(): any[]
  delete(id: string): void
  switch(id: string): void
  getCurrent(): any | undefined
}
declare module '../cordis/src/context.ts' {
  interface Context { session: SessionService }
}

// ==================== 5. Storage ====================
export interface StorageService {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  list(prefix?: string): string[]
}
declare module '../cordis/src/context.ts' {
  interface Context { storage: StorageService }
}

// ==================== 6. Context Manager ====================
export interface ContextManagerService {
  build(systemConfig: any): string
  compact(messages: any[]): Promise<any[]>
  getHistory(sessionId: string): any[]
}
declare module '../cordis/src/context.ts' {
  interface Context { contextManager: ContextManagerService }
}

// ==================== 7. Memory ====================
export interface MemoryServiceDef {
  add(entry: any): void
  query(filter: any): any[]
  clear(): void
  getScopes(): string[]
}
declare module '../cordis/src/context.ts' {
  interface Context { memory: MemoryServiceDef }
}

// ==================== 8. Permission ====================
export interface PermissionService {
  check(action: string, resource?: any): boolean
  request(action: string, resource?: any): Promise<boolean>
  grant(action: string): void
  revoke(action: string): void
}
declare module '../cordis/src/context.ts' {
  interface Context { permission: PermissionService }
}

// ==================== 9. MCP ====================
export interface MCPService {
  registerServer(config: any): Promise<void>
  unregisterServer(id: string): void
  listServers(): any[]
  callTool(server: string, tool: string, input: any): Promise<any>
}
declare module '../cordis/src/context.ts' {
  interface Context { mcp: MCPService }
}

// ==================== 10. Skill ====================
export interface SkillService {
  register(definition: any): () => void
  execute(name: string, input: any): Promise<any>
  list(): any[]
  install(name: string): Promise<void>
  uninstall(name: string): void
}
declare module '../cordis/src/context.ts' {
  interface Context { skill: SkillService }
}

// ==================== 11. Recovery ====================
export interface RecoveryService {
  save(sessionId: string): Promise<void>
  restore(sessionId: string): Promise<boolean>
  listSnapshots(): any[]
}
declare module '../cordis/src/context.ts' {
  interface Context { recovery: RecoveryService }
}

// ==================== 12. Snapshot ====================
export interface SnapshotService {
  take(sessionId: string): any
  restore(snapshot: any): void
  list(): any[]
  diff(a: any, b: any): any
}
declare module '../cordis/src/context.ts' {
  interface Context { snapshot: SnapshotService }
}

// ==================== 13. Subagent ====================
export interface SubagentService {
  spawn(task: any): Promise<any>
  list(): any[]
  getResult(id: string): any | undefined
  kill(id: string): void
}
declare module '../cordis/src/context.ts' {
  interface Context { subagent: SubagentService }
}

// ==================== 14. Retry ====================
export interface RetryService {
  execute<T>(fn: () => Promise<T>, config?: any): Promise<T>
  getConfig(): any
  setConfig(config: any): void
}
declare module '../cordis/src/context.ts' {
  interface Context { retry: RetryService }
}

// ==================== 15. Prompt ====================
export interface PromptService {
  build(config: any): string
  registerTemplate(name: string, template: string): void
  getTemplate(name: string): string | undefined
}
declare module '../cordis/src/context.ts' {
  interface Context { prompt: PromptService }
}

// ==================== 16. Heartbeat ====================
export interface HeartbeatService {
  start(interval: number): void
  stop(): void
  isAlive(): boolean
  onBeat(cb: () => void): () => void
}
declare module '../cordis/src/context.ts' {
  interface Context { heartbeat: HeartbeatService }
}

// ==================== 17. Settings ====================
export interface SettingsService {
  get<T>(key: string, defaultValue?: T): T
  set<T>(key: string, value: T): void
  getAll(): Record<string, any>
  watch(key: string, cb: (value: any) => void): () => void
}
declare module '../cordis/src/context.ts' {
  interface Context { settings: SettingsService }
}

// ==================== 18. Theme ====================
export interface ThemeService {
  getCurrent(): string
  setTheme(name: string): void
  listThemes(): { name: string; label: string }[]
  registerTheme(name: string, css: string): void
  onThemeChange(cb: (theme: string) => void): () => void
}
declare module '../cordis/src/context.ts' {
  interface Context { theme: ThemeService }
}

// ==================== 19. Compaction (遗漏补齐) ====================
export interface CompactionService {
  check(messages: any[]): Promise<{ needCompact: boolean; tokenCount: number }>
  compact(messages: any[]): Promise<any[]>
  getThreshold(): number
  setThreshold(tokens: number): void
}
declare module '../cordis/src/context.ts' {
  interface Context { compaction: CompactionService }
}

// ==================== 20. Approval (遗漏补齐) ====================
export interface ApprovalService {
  request(action: string, resource?: any): Promise<{ approved: boolean; reason?: string }>
  getPending(): Array<{ id: string; action: string; resource?: any }>
  resolve(id: string, approved: boolean, reason?: string): void
}
declare module '../cordis/src/context.ts' {
  interface Context { approval: ApprovalService }
}

// ==================== 21. Permissions (遗漏补齐, 区别于 #8 Permission) ====================
export interface PermissionsService {
  presets(): Array<{ id: string; label: string; rules: any[] }>
  applyPreset(presetId: string): void
  getCurrentPreset(): string
  registerPreset(preset: { id: string; label: string; rules: any[] }): void
}
declare module '../cordis/src/context.ts' {
  interface Context { permissions: PermissionsService }
}

// ==================== 22. Hooks (遗漏补齐) ====================
export interface HooksService {
  on(event: string, handler: (...args: any[]) => void): () => void
  before(event: string, handler: (...args: any[]) => any): () => void
  after(event: string, handler: (...args: any[]) => any): () => void
  emit(event: string, ...args: any[]): void
}
declare module '../cordis/src/context.ts' {
  interface Context { hooks: HooksService }
}

// ==================== 23. Automation (遗漏补齐) ====================
export interface AutomationService {
  registerTrigger(name: string, config: any): void
  removeTrigger(name: string): void
  listTriggers(): Array<{ name: string; config: any }>
  enable(name: string): void
  disable(name: string): void
}
declare module '../cordis/src/context.ts' {
  interface Context { automation: AutomationService }
}

// ==================== P5 能力族 ====================
// FS 能力族
export * from './fs/index.ts'
// Shell 能力族
export * from './shell/index.ts'
// Sandbox 能力族
export * from './sandbox/index.ts'
// Web 能力族
export * from './web/index.ts'
// Subagent 能力族（新接口，与 #13 SubagentService 共存）
export * from './subagent/index.ts'
// Skill 能力族（新接口，与 #10 SkillService 共存）
export * from './skill/index.ts'
// 凭证/附件/知识/调度/目标/计划/后台任务
export * from './misc/index.ts'
// P6: 剩余后端能力 (identity/guard/LSP/code-runtime/workflow/context/commands/user-questions/notebook/squad)
export * from './extra/index.ts'
// P6: Self-Referential Runtime (dynamicCordisRunner)
export * from './extensions/index.ts'
// P6 遗漏补齐: Preset/Bundle/SDK/ACP/Host/Client
export * from './infra/index.ts'
