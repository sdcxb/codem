// @ts-nocheck
/**
 * Codem 桥接插件 — 将现有单例服务包装为 Cordis Service Provider。
 *
 * 这个插件在 App 启动时加载，将 src/core/ 下现有的单例服务
 * 注册到 Cordis Context 中，使它们可以通过插件替换。
 *
 * 每个服务使用 ctx.provide() 注册，返回 disposer。
 * 当插件卸载时，服务自动注销。
 */

import { Service, type Context, type Plugin } from '../cordis/src/index.ts'

// 现有实现导入
import { ProviderRegistry, createDefaultProviders } from '../llm/provider'
import { ToolRegistry, createDefaultToolRegistry } from '../llm/tools'
import { AgenticLoop } from '../llm/agentic-loop'
import { AgentRegistry, getAgentRegistry } from '../agent/agent'
import { PermissionManager, getPermissionManager } from '../permission/permission'
import { ContextManager, getContextManager } from '../context/context'
import { MemoryService, getMemoryService } from '../memory/memory'
import { RetryExecutor, getRetryExecutor } from '../retry/retry'
import { buildSystemPrompt } from '../prompt/prompt'
import { MCPRegistry, getMCPRegistry } from '../mcp/mcp'
import { SkillRegistry, getSkillRegistry } from '../skill/skill'
import { SnapshotService, getSnapshotService } from '../snapshot/snapshot'
import { SubagentManager, getSubagentManager } from '../subagent/subagent'
import { SessionRecoveryService, getSessionRecoveryService } from '../recovery/recovery'
import { SettingsManager, getSettingsManager } from '../settings/settings'
import { HeartbeatManager, getHeartbeatManager } from '../heartbeat/heartbeat'
import { ThemeManager } from '../theme'

/**
 * 桥接插件 — 注册所有核心服务到 Cordis Context。
 *
 * 使用方式：
 * ```typescript
 * const ctx = new Context()
 * ctx.plugin(bridgePlugin)
 * // 现在 ctx.llm, ctx.tools, ctx.session 等都可用了
 * ```
 */
export const bridgePlugin: Plugin = (ctx: Context) => {
  // 1. LLM Provider
  const providers = createDefaultProviders()
  ctx.provide('llm', {
    complete: async (request: any) => {
      const provider = providers.get(request.provider || 'mimo')
      return provider?.complete(request)
    },
    stream: async function* (request: any) {
      const provider = providers.get(request.provider || 'mimo')
      if (provider) {
        yield* provider.stream(request)
      }
    },
    listModels: async () => {
      const allModels: any[] = []
      for (const provider of providers.values()) {
        allModels.push(...(await provider.listModels()))
      }
      return allModels
    },
    isConfigured: () => true,
  })

  // 2. Tools
  const tools = createDefaultToolRegistry()
  ctx.provide('tools', {
    register: (def: any) => tools.register(def),
    execute: async (name: string, input: any) => tools.execute(name, input),
    list: () => tools.list(),
    get: (name: string) => tools.get(name),
  })

  // 3. Agent Loop (延迟初始化，依赖 LLM 和 Tools)
  ctx.provide('agentLoop', {
    run: async (sessionId: string, config?: any) => {
      // AgenticLoop 需要在实际使用时创建
      return null
    },
    stop: (sessionId: string) => {},
    getState: (sessionId: string) => null,
  })

  // 4. Session
  ctx.provide('session', {
    _sessions: new Map(),
    _current: null as string | null,
    create(config?: any) {
      const id = crypto.randomUUID()
      const session = { id, ...config, messages: [], createdAt: Date.now() }
      this._sessions.set(id, session)
      return session
    },
    get(id: string) { return this._sessions.get(id) },
    list() { return [...this._sessions.values()] },
    delete(id: string) { this._sessions.delete(id) },
    switch(id: string) {
      if (this._sessions.has(id)) this._current = id
    },
    getCurrent() { return this._current ? this._sessions.get(this._current) : undefined },
  })

  // 5. Storage
  ctx.provide('storage', {
    get: <T>(key: string): T | undefined => {
      const v = localStorage.getItem(`codem:${key}`)
      return v ? JSON.parse(v) : undefined
    },
    set: <T>(key: string, value: T) => {
      localStorage.setItem(`codem:${key}`, JSON.stringify(value))
    },
    delete: (key: string) => localStorage.removeItem(`codem:${key}`),
    list: (prefix?: string) => {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!
        if (k.startsWith('codem:') && (!prefix || k.includes(prefix))) {
          keys.push(k.replace('codem:', ''))
        }
      }
      return keys
    },
  })

  // 6. Context Manager
  const contextMgr = getContextManager()
  ctx.provide('contextManager', {
    build: (systemConfig: any) => buildSystemPrompt(systemConfig),
    compact: async (messages: any[]) => contextMgr.compactMessages(messages),
    getHistory: (sessionId: string) => [],
  })

  // 7. Memory
  const memory = getMemoryService()
  ctx.provide('memory', {
    add: (entry: any) => memory.add(entry),
    query: (filter: any) => memory.query(filter),
    clear: () => memory.clear(),
    getScopes: () => ['global', 'session', 'project'],
  })

  // 8. Permission
  const permMgr = getPermissionManager()
  ctx.provide('permission', {
    check: (action: string, resource?: any) => permMgr.check(action, resource),
    request: async (action: string, resource?: any) => permMgr.request(action, resource),
    grant: (action: string) => permMgr.grant(action),
    revoke: (action: string) => permMgr.revoke(action),
  })

  // 9. MCP
  const mcpRegistry = getMCPRegistry()
  ctx.provide('mcp', {
    registerServer: async (config: any) => { await mcpRegistry.addServer(config) },
    unregisterServer: (id: string) => { mcpRegistry.removeServer(id) },
    listServers: () => mcpRegistry.listServers(),
    callTool: async (server: string, tool: string, input: any) => mcpRegistry.callTool(server, tool, input),
  })

  // 10. Skill
  const skillRegistry = getSkillRegistry()
  ctx.provide('skill', {
    register: (def: any) => skillRegistry.register(def),
    execute: async (name: string, input: any) => skillRegistry.execute(name, input),
    list: () => skillRegistry.list(),
    install: async (name: string) => { await skillRegistry.install(name) },
    uninstall: (name: string) => { skillRegistry.uninstall(name) },
  })

  // 11. Recovery
  const recovery = getSessionRecoveryService()
  ctx.provide('recovery', {
    save: async (sessionId: string) => { await recovery.saveSnapshot(sessionId) },
    restore: async (sessionId: string) => recovery.restore(sessionId),
    listSnapshots: () => recovery.listSnapshots(),
  })

  // 12. Snapshot
  const snapshot = getSnapshotService()
  ctx.provide('snapshot', {
    take: (sessionId: string) => snapshot.take(sessionId),
    restore: (snap: any) => snapshot.restore(snap),
    list: () => snapshot.list(),
    diff: (a: any, b: any) => snapshot.diff(a, b),
  })

  // 13. Subagent
  const subagentMgr = getSubagentManager()
  ctx.provide('subagent', {
    spawn: async (task: any) => subagentMgr.spawn(task),
    list: () => subagentMgr.list(),
    getResult: (id: string) => subagentMgr.getResult(id),
    kill: (id: string) => subagentMgr.kill(id),
  })

  // 14. Retry
  const retryExec = getRetryExecutor()
  ctx.provide('retry', {
    execute: async <T>(fn: () => Promise<T>, config?: any) => retryExec.execute(fn, config),
    getConfig: () => retryExec.getConfig(),
    setConfig: (config: any) => retryExec.setConfig(config),
  })

  // 15. Prompt
  ctx.provide('prompt', {
    _templates: new Map<string, string>(),
    build: (config: any) => buildSystemPrompt(config),
    registerTemplate: (name: string, template: string) => { this._templates.set(name, template) },
    getTemplate: (name: string) => this._templates.get(name),
  })

  // 16. Heartbeat
  const heartbeat = getHeartbeatManager()
  ctx.provide('heartbeat', {
    start: (interval: number) => heartbeat.start(interval),
    stop: () => heartbeat.stop(),
    isAlive: () => heartbeat.isAlive(),
    onBeat: (cb: () => void) => heartbeat.onBeat(cb),
  })

  // 17. Settings
  const settingsMgr = getSettingsManager()
  ctx.provide('settings', {
    get: <T>(key: string, defaultValue?: T) => settingsMgr.get(key, defaultValue),
    set: <T>(key: string, value: T) => settingsMgr.set(key, value),
    getAll: () => settingsMgr.getAll(),
    watch: (key: string, cb: (value: any) => void) => settingsMgr.watch(key, cb),
  })

  // 18. Theme
  const themeMgr = new ThemeManager()
  ctx.provide('theme', {
    getCurrent: () => themeMgr.getCurrent(),
    setTheme: (name: string) => themeMgr.setTheme(name),
    listThemes: () => themeMgr.listThemes(),
    registerTheme: (name: string, css: string) => themeMgr.registerTheme(name, css),
    onThemeChange: (cb: (theme: string) => void) => themeMgr.onThemeChange(cb),
  })

  // Slot Registry
  // SlotsService 在构造函数中自动注册为 ctx.slots
  // 需要在 bridgePlugin 之外单独加载
}
