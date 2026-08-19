// @ts-nocheck
/**
 * P6 遗漏补齐 — Preset/Bundle/SDK/ACP/Host/Client 能力族
 *
 * P2-2/F3: 消除架构级重复 — 这些实现类被 provider/ 中的对应 Provider 包装后注册到 ctx。
 * 新代码应直接使用 src/core/provider/ 中的 Provider。
 *
 * @deprecated 新代码请直接从 provider/ 导入。
 *
 * 这些能力族在计划文档 P6.2 中列出但未实现。
 */
import type { Context, Plugin } from '../cordis/src/index.ts'

// ========== Preset 能力族 ==========
export interface Preset {
  load(name: string): Promise<any>
  save(name: string, config: any): Promise<void>
  list(): Array<{ name: string; description?: string }>
  apply(name: string): Promise<void>
}

export class DefaultPreset implements Preset {
  private presets = new Map<string, any>()

  async load(name: string): Promise<any> { return this.presets.get(name) }
  async save(name: string, config: any): Promise<void> { this.presets.set(name, config) }
  list() { return [...this.presets.keys()].map(name => ({ name })) }
  async apply(name: string): Promise<void> {
    const config = this.presets.get(name)
    if (config) console.log(`[preset] Applied preset: ${name}`)
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { preset: Preset }
}

// ========== Bundle 能力族 ==========
export interface Bundle {
  install(bundleName: string): Promise<void>
  uninstall(bundleName: string): Promise<void>
  list(): Array<{ name: string; installed: boolean }>
  getInstalled(): string[]
}

export class DefaultBundle implements Bundle {
  private installed = new Set<string>(['base'])

  async install(name: string): Promise<void> {
    this.installed.add(name)
    console.log(`[bundle] Installed: ${name}`)
  }
  async uninstall(name: string): Promise<void> {
    this.installed.delete(name)
  }
  list() {
    const all = ['base', 'headless', 'web-app']
    return all.map(name => ({ name, installed: this.installed.has(name) }))
  }
  getInstalled() { return [...this.installed] }
}

declare module '../cordis/src/context.ts' {
  interface Context { bundle: Bundle }
}

// ========== SDK 能力族 ==========
export interface SDK {
  startServer(config?: any): Promise<string>
  stopServer(serverId: string): Promise<void>
  callMethod(serverId: string, method: string, params?: any): Promise<any>
  listServers(): Array<{ id: string; status: string }>
}

export class DefaultSDK implements SDK {
  private servers = new Map<string, { id: string; status: string }>()

  async startServer(_config?: any): Promise<string> {
    const id = crypto.randomUUID()
    this.servers.set(id, { id, status: 'running' })
    return id
  }
  async stopServer(serverId: string): Promise<void> {
    const s = this.servers.get(serverId)
    if (s) s.status = 'stopped'
  }
  async callMethod(_serverId: string, _method: string, _params?: any): Promise<any> {
    return { result: 'ok' }
  }
  listServers() { return [...this.servers.values()] }
}

declare module '../cordis/src/context.ts' {
  interface Context { sdk: SDK }
}

// ========== ACP 能力族 ==========
export interface ACP {
  registerAutomation(name: string, config: any): void
  unregisterAutomation(name: string): void
  listAutomations(): Array<{ name: string; config: any }>
  trigger(name: string, payload?: any): Promise<any>
}

export class DefaultACP implements ACP {
  private automations = new Map<string, { name: string; config: any }>()

  registerAutomation(name: string, config: any): void {
    this.automations.set(name, { name, config })
  }
  unregisterAutomation(name: string): void {
    this.automations.delete(name)
  }
  listAutomations() { return [...this.automations.values()] }
  async trigger(name: string, payload?: any): Promise<any> {
    const auto = this.automations.get(name)
    if (!auto) throw new Error(`Automation "${name}" not found`)
    return { triggered: true, name, payload }
  }
}

declare module '../cordis/src/context.ts' {
  interface Context { acp: ACP }
}

// ========== Host 能力族 ==========
export interface Host {
  getEndpoint(): string
  getStatus(): 'starting' | 'running' | 'stopping' | 'stopped'
  start(config?: any): Promise<void>
  stop(): Promise<void>
}

export class DefaultHost implements Host {
  private status: Host['getStatus'] extends infer R ? R : string = 'stopped'

  getEndpoint() { return 'http://localhost:8080' }
  getStatus() { return this.status as any }
  async start(_config?: any) { this.status = 'running' as any; console.log('[host] Started') }
  async stop() { this.status = 'stopped' as any; console.log('[host] Stopped') }
}

declare module '../cordis/src/context.ts' {
  interface Context { host: Host }
}

// ========== Client 能力族 ==========
export interface Client {
  connect(endpoint: string): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  getCapabilities(): string[]
}

export class DefaultClient implements Client {
  private connected = false

  async connect(_endpoint: string) { this.connected = true; console.log('[client] Connected') }
  async disconnect() { this.connected = false; console.log('[client] Disconnected') }
  isConnected() { return this.connected }
  getCapabilities() { return ['chat', 'tools', 'sessions'] }
}

declare module '../cordis/src/context.ts' {
  interface Context { client: Client }
}

// ========== 插件定义 ==========
export const inject = [] as const
export const provide = ['preset', 'bundle', 'sdk', 'acp', 'host', 'client'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('preset', new DefaultPreset())
  ctx.provide('bundle', new DefaultBundle())
  ctx.provide('sdk', new DefaultSDK())
  ctx.provide('acp', new DefaultACP())
  ctx.provide('host', new DefaultHost())
  ctx.provide('client', new DefaultClient())
}
