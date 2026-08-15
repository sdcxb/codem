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

  // ===== P5 能力族 Provider 注册 =====

  // 19. FileSystem (P5.1)
  ctx.provide('fs', {
    readFile: async (path: string, cwd?: string) => {
      const { readFile } = await import('../file-api')
      const resolvedPath = (cwd && !path.startsWith('/') && !path.match(/^[A-Za-z]:/))
        ? `${cwd.replace(/[/\\]+$/, '')}/${path}` : path
      return readFile(resolvedPath)
    },
    writeFile: async (path: string, content: string, cwd?: string) => {
      const { writeFile } = await import('../file-api')
      return writeFile(path, content, { workspace: cwd })
    },
    listDirectory: async (path: string) => {
      const { listDirectory } = await import('../file-api')
      const entries = await listDirectory(path)
      return entries.map(e => ({ name: e.name, isDir: e.isDirectory, size: 0 }))
    },
    deleteFile: async (path: string) => {
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) await invoke('delete_file', { path })
    },
    exists: async (path: string) => {
      try {
        const { listDirectory } = await import('../file-api')
        const parent = path.split(/[\\/]/).slice(0, -1).join('/') || '/'
        const name = path.split(/[\\/]/).pop() || ''
        const entries = await listDirectory(parent)
        return entries.some(e => e.name === name)
      } catch { return false }
    },
    glob: async (pattern: string, cwd?: string) => {
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) return await invoke('glob_files', { pattern, cwd: cwd || '.' })
      return []
    },
    grep: async (pattern: string, cwd?: string, glob?: string) => {
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) return await invoke('grep_files', { pattern, cwd: cwd || '.', glob: glob || '*' })
      return []
    },
  })

  // 20. Shell (P5.2)
  ctx.provide('shell', {
    execute: async (command: string, cwd: string, timeoutMs?: number) => {
      const { invoke } = (window as any).__TAURI__?.core || {}
      if (invoke) {
        try {
          return await invoke('execute_command', { command, cwd, timeoutMs: timeoutMs || 30000 })
        } catch (err: any) {
          return { stdout: '', stderr: String(err), exitCode: 1 }
        }
      }
      return { stdout: '', stderr: 'Tauri not available', exitCode: 1 }
    },
  })

  // 21. Sandbox (P5.3)
  const sandboxInstances = new Map<string, any>()
  ctx.provide('sandbox', {
    create: async (config?: any) => {
      const id = crypto.randomUUID()
      const instance = {
        id,
        rootPath: config?.rootPath || '/tmp/sandbox-' + id,
        writablePaths: config?.writablePaths || [],
        env: config?.env || {},
        isActive: true,
      }
      sandboxInstances.set(id, instance)
      return instance
    },
    destroy: async (id: string) => {
      const inst = sandboxInstances.get(id)
      if (inst) { inst.isActive = false; sandboxInstances.delete(id) }
    },
    list: () => [...sandboxInstances.values()],
  })

  // 22. Web (P5.4)
  ctx.provide('web', {
    search: async (query: string) => {
      // 委托给现有 web-search 工具的实现
      try {
        const { webSearch } = await import('../llm/tools/web-search')
        return await webSearch(query)
      } catch { return [] }
    },
    fetch: async (url: string) => {
      const response = await globalThis.fetch(url)
      return response.text()
    },
  })

  // 23. Subagents (P5.6) — 与 P4 的 subagent 不同，这是新接口
  ctx.provide('subagents', {
    spawn: async (parentSessionId: string, agentId: string, prompt: string, cwd: string, abort?: AbortSignal) => {
      const task = await subagentMgr.spawn({ parentSessionId, agentId, prompt, cwd, abort } as any)
      return { id: task.id, name: task.name }
    },
    getTask: (taskId: string) => subagentMgr.getResult(taskId),
    waitForTask: async (taskId: string, abort?: AbortSignal) => subagentMgr.waitForTask(taskId, abort),
  })

  // 24. Skills (P5.5) — 新接口，与 P4 的 skill 不同
  ctx.provide('skills', {
    loadInstalled: async () => {
      const { loadInstalledSkills } = await import('../skill/installer')
      await loadInstalledSkills()
    },
    search: async (query: string) => {
      const all = skillRegistry.listSkills()
      return all
        .filter((s: any) => s.name.toLowerCase().includes(query.toLowerCase()) || s.description?.toLowerCase().includes(query.toLowerCase()))
        .map((s: any) => ({ id: s.id, name: s.name, description: s.description || '', source: s.source }))
    },
    get: (skillId: string) => skillRegistry.getSkill(skillId),
    install: async (zipPath: string, onProgress?: (p: number) => void) => {
      const { installSkillFromZip } = await import('../skill/installer')
      return installSkillFromZip(zipPath, onProgress)
    },
    uninstall: async (skillId: string) => {
      const { uninstallSkill } = await import('../skill/installer')
      await uninstallSkill(skillId)
    },
    listMarket: async () => {
      const { listMarketSkills } = await import('../skill/skill-market-client')
      return listMarketSkills()
    },
    installFromMarket: async (skillId: string) => {
      const { installMarketSkill } = await import('../skill/skill-market-client')
      await installMarketSkill(skillId)
      return { success: true }
    },
  })

  // 25. Credentials (P5.7)
  const credStore: Record<string, string> = {}
  ctx.provide('credentials', {
    get: (key: string) => credStore[key] || process.env?.[key] || undefined,
    set: (key: string, value: string) => { credStore[key] = value },
    delete: (key: string) => { delete credStore[key] },
    list: () => Object.keys(credStore),
  })

  // 26. Attachments (P5.7)
  const attachmentStore = new Map<string, string | Uint8Array>()
  ctx.provide('attachments', {
    store: async (content: string | Uint8Array) => {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      const hash = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('')
      attachmentStore.set(hash, content)
      return hash
    },
    get: async (hash: string) => attachmentStore.get(hash),
    delete: async (hash: string) => { attachmentStore.delete(hash) },
  })

  // 27. Knowledge (P5.7)
  const knowledgeItems: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = []
  ctx.provide('knowledge', {
    add: async (text: string, metadata?: Record<string, unknown>) => {
      const id = crypto.randomUUID()
      knowledgeItems.push({ id, text, metadata })
      return id
    },
    search: async (query: string, limit: number = 10) => {
      const q = query.toLowerCase()
      return knowledgeItems
        .map(item => ({ id: item.id, text: item.text, score: item.text.toLowerCase().includes(q) ? 1 : 0 }))
        .filter(r => r.score > 0)
        .slice(0, limit)
    },
    remove: async (id: string) => {
      const idx = knowledgeItems.findIndex(i => i.id === id)
      if (idx >= 0) knowledgeItems.splice(idx, 1)
    },
  })

  // 28. Schedule (P5.7)
  const reminders: Array<{ id: string; time: Date; message: string; sessionId?: string; timer?: any }> = []
  ctx.provide('schedule', {
    addReminder: (time: Date, message: string, sessionId?: string) => {
      const id = crypto.randomUUID()
      const delay = time.getTime() - Date.now()
      const reminder: any = { id, time, message, sessionId }
      if (delay > 0) {
        reminder.timer = setTimeout(() => {
          console.log(`[Schedule] Reminder: ${message}`)
          const idx = reminders.findIndex(r => r.id === id)
          if (idx >= 0) reminders.splice(idx, 1)
        }, delay)
      }
      reminders.push(reminder)
      return id
    },
    listReminders: (sessionId?: string) => {
      return reminders
        .filter(r => !sessionId || r.sessionId === sessionId)
        .map(({ id, time, message }) => ({ id, time, message }))
    },
    removeReminder: (id: string) => {
      const r = reminders.find(r => r.id === id)
      if (r?.timer) clearTimeout(r.timer)
      const idx = reminders.findIndex(r => r.id === id)
      if (idx >= 0) reminders.splice(idx, 1)
    },
  })

  // 29. Goals (P5.7)
  const goalsStore: Array<{ id: string; title: string; description?: string; criteria?: string[]; status: string }> = []
  ctx.provide('goals', {
    set: (goal: { title: string; description?: string; criteria?: string[] }) => {
      const id = crypto.randomUUID()
      goalsStore.push({ id, ...goal, status: 'active' })
      return id
    },
    get: (goalId: string) => goalsStore.find(g => g.id === goalId),
    list: () => goalsStore.map(({ id, title, status }) => ({ id, title, status })),
    update: (goalId: string, status: string) => {
      const g = goalsStore.find(g => g.id === goalId)
      if (g) g.status = status
    },
    remove: (goalId: string) => {
      const idx = goalsStore.findIndex(g => g.id === goalId)
      if (idx >= 0) goalsStore.splice(idx, 1)
    },
  })

  // 30. Plans (P5.7)
  const plansStore: Array<{ id: string; title: string; steps: Array<{ text: string; done: boolean }> }> = []
  ctx.provide('plans', {
    create: (title: string, steps: string[]) => {
      const id = crypto.randomUUID()
      plansStore.push({ id, title, steps: steps.map(text => ({ text, done: false })) })
      return id
    },
    get: (planId: string) => plansStore.find(p => p.id === planId),
    list: () => plansStore.map(p => ({
      id: p.id, title: p.title,
      progress: p.steps.filter(s => s.done).length / p.steps.length,
    })),
    updateStep: (planId: string, stepIndex: number, done: boolean) => {
      const p = plansStore.find(p => p.id === planId)
      if (p && p.steps[stepIndex]) p.steps[stepIndex].done = done
    },
    remove: (planId: string) => {
      const idx = plansStore.findIndex(p => p.id === planId)
      if (idx >= 0) plansStore.splice(idx, 1)
    },
  })

  // 31. Jobs (P5.7)
  const jobsStore = new Map<string, { id: string; name: string; status: string; result?: any; error?: string; abortController: AbortController }>()
  ctx.provide('jobs', {
    start: (task: { name: string; fn: () => Promise<any> }) => {
      const id = crypto.randomUUID()
      const abortController = new AbortController()
      const job: any = { id, name: task.name, status: 'running', abortController }
      jobsStore.set(id, job)
      task.fn()
        .then(result => { job.status = 'completed'; job.result = result })
        .catch(err => { job.status = 'failed'; job.error = err.message })
      return id
    },
    get: (jobId: string) => {
      const j = jobsStore.get(jobId)
      if (!j) return undefined
      return { id: j.id, name: j.name, status: j.status, result: j.result, error: j.error }
    },
    list: () => [...jobsStore.values()].map(j => ({ id: j.id, name: j.name, status: j.status })),
    cancel: (jobId: string) => {
      const j = jobsStore.get(jobId)
      if (j) { j.abortController.abort(); j.status = 'cancelled' }
    },
  })

  // Slot Registry
  // SlotsService 在构造函数中自动注册为 ctx.slots
  // 需要在 bridgePlugin 之外单独加载
}
