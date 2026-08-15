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

  // ===== 遗漏补齐: compaction/approval/permissions/hooks/automation =====

  // 19b. Compaction
  ctx.provide('compaction', {
    _threshold: 80000,
    check: async (messages: any[]) => {
      // 粗略估算 token 数量
      const tokenCount = messages.reduce((sum: number, m: any) => {
        const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')
        return sum + Math.ceil(content.length / 4)
      }, 0)
      return { needCompact: tokenCount > 80000, tokenCount }
    },
    compact: async (messages: any[]) => {
      // 简单实现：保留系统消息和最近 10 条
      const system = messages.filter((m: any) => m?.role === 'system')
      const recent = messages.slice(-10)
      return [...system, ...recent]
    },
    getThreshold() { return 80000 },
    setThreshold(tokens: number) { console.log(`[compaction] Threshold set to ${tokens}`) },
  })

  // 20b. Approval
  const pendingApprovals: any[] = []
  ctx.provide('approval', {
    request: async (action: string, resource?: any) => {
      const id = crypto.randomUUID()
      return new Promise(resolve => {
        pendingApprovals.push({ id, action, resource, resolve })
      })
    },
    getPending: () => pendingApprovals.map(({ id, action, resource }) => ({ id, action, resource })),
    resolve: (id: string, approved: boolean, reason?: string) => {
      const idx = pendingApprovals.findIndex(p => p.id === id)
      if (idx >= 0) { pendingApprovals[idx].resolve({ approved, reason }); pendingApprovals.splice(idx, 1) }
    },
  })

  // 21b. Permissions (presets)
  const permPresets = new Map<string, { id: string; label: string; rules: any[] }>([
    ['default', { id: 'default', label: 'Default', rules: [{ allow: ['read', 'write', 'list'] }] }],
    ['strict', { id: 'strict', label: 'Strict', rules: [{ allow: ['read'], deny: ['write', 'delete'] }] }],
    ['open', { id: 'open', label: 'Open', rules: [{ allow: '*' }] }],
  ])
  let currentPreset = 'default'
  ctx.provide('permissions', {
    presets: () => [...permPresets.values()],
    applyPreset: (presetId: string) => { if (permPresets.has(presetId)) currentPreset = presetId },
    getCurrentPreset: () => currentPreset,
    registerPreset: (preset: { id: string; label: string; rules: any[] }) => { permPresets.set(preset.id, preset) },
  })

  // 22b. Hooks
  const hookHandlers = new Map<string, Array<{ type: string; handler: (...args: any[]) => any }>>()
  ctx.provide('hooks', {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!hookHandlers.has(event)) hookHandlers.set(event, [])
      hookHandlers.get(event)!.push({ type: 'on', handler })
      return () => { hookHandlers.set(event, (hookHandlers.get(event) || []).filter(h => h.handler !== handler)) }
    },
    before: (event: string, handler: (...args: any[]) => any) => {
      if (!hookHandlers.has(event)) hookHandlers.set(event, [])
      hookHandlers.get(event)!.push({ type: 'before', handler })
      return () => { hookHandlers.set(event, (hookHandlers.get(event) || []).filter(h => h.handler !== handler)) }
    },
    after: (event: string, handler: (...args: any[]) => any) => {
      if (!hookHandlers.has(event)) hookHandlers.set(event, [])
      hookHandlers.get(event)!.push({ type: 'after', handler })
      return () => { hookHandlers.set(event, (hookHandlers.get(event) || []).filter(h => h.handler !== handler)) }
    },
    emit: (event: string, ...args: any[]) => {
      const handlers = hookHandlers.get(event) || []
      for (const h of handlers) {
        if (h.type === 'on' || h.type === 'after') h.handler(...args)
      }
    },
  })

  // 23b. Automation
  const triggers = new Map<string, { name: string; config: any; enabled: boolean }>()
  ctx.provide('automation', {
    registerTrigger: (name: string, config: any) => { triggers.set(name, { name, config, enabled: true }) },
    removeTrigger: (name: string) => { triggers.delete(name) },
    listTriggers: () => [...triggers.values()],
    enable: (name: string) => { const t = triggers.get(name); if (t) t.enabled = true },
    disable: (name: string) => { const t = triggers.get(name); if (t) t.enabled = false },
  })

  // 24b. FS-Sandbox (遗漏补齐 — 沙箱化文件系统)
  ctx.provide('fsSandbox', {
    _wrapped: null,
    init(sandboxRoot: string, writablePaths: string[]) {
      this._wrapped = { sandboxRoot, writablePaths }
    },
    async readFile(path: string, cwd?: string) {
      // 委托给 ctx.fs（fs-sandbox 是 fs 的 Consumer 而非 Provider）
      return ctx.fs.readFile(path, cwd)
    },
    async writeFile(path: string, content: string, cwd?: string) {
      if (this._wrapped) {
        const allowed = this._wrapped.writablePaths.some((p: string) => path.startsWith(p))
        if (!allowed) throw new Error(`Write denied: ${path} is not in writable paths`)
      }
      return ctx.fs.writeFile(path, content, cwd)
    },
    async listDirectory(path: string) { return ctx.fs.listDirectory(path) },
    async deleteFile(path: string) {
      if (this._wrapped) {
        const allowed = this._wrapped.writablePaths.some((p: string) => path.startsWith(p))
        if (!allowed) throw new Error(`Delete denied: ${path} is not in writable paths`)
      }
      return ctx.fs.deleteFile(path)
    },
    async exists(path: string) { return ctx.fs.exists(path) },
    async glob(pattern: string, cwd?: string) { return ctx.fs.glob(pattern, cwd) },
    async grep(pattern: string, cwd?: string, glob?: string) { return ctx.fs.grep(pattern, cwd, glob) },
  })

  // ===== P6 能力族 Provider 注册 =====

  // 32. Identity (P6.2)
  ctx.provide('identity', {
    _id: crypto.randomUUID(),
    getId() { return this._id },
    getName() { return 'Anonymous' },
  })

  // 33. Guard (P6.2)
  const callHistory = new Map<string, any[]>()
  ctx.provide('guard', {
    checkRepeat(toolName: string, args: any) {
      const argStr = JSON.stringify(args)
      const now = Date.now()
      const history = callHistory.get('global') || []
      const recent = history.filter((h: any) => h.tool === toolName && h.args === argStr && now - h.time < 5000)
      if (recent.length > 0) return { isRepeat: true, message: `Tool "${toolName}" was called with the same args recently` }
      history.push({ tool: toolName, args: argStr, time: now })
      if (history.length > 100) history.shift()
      callHistory.set('global', history)
      return { isRepeat: false }
    },
    checkDeadline(_sessionId: string) { return { exceeded: false } },
  })

  // 34. LSP (P6.2)
  ctx.provide('lsp', {
    async start(_workspace: string) { return crypto.randomUUID() },
    async stop(_id: string) {},
    async getDiagnostics(_file: string) { return [] },
    async hover(_file: string, _line: number, _col: number) { return null },
    async completions(_file: string, _line: number, _col: number) { return [] },
  })

  // 35. Code Runtime (P6.2)
  ctx.provide('codeRuntime', {
    async execute(_code: string, _language: string, _cwd?: string) {
      return { stdout: '', stderr: 'Code runtime not available in browser', exitCode: 1 }
    },
  })

  // 36. Workflow (P6.2)
  const workflows = new Map<string, any>()
  ctx.provide('workflow', {
    create(steps: any[]) {
      const id = crypto.randomUUID()
      workflows.set(id, { id, steps, status: 'pending', step: 0, results: [] })
      return id
    },
    async run(workflowId: string) {
      const wf = workflows.get(workflowId)
      if (!wf) return { success: false, results: [] }
      wf.status = 'running'
      for (let i = 0; i < wf.steps.length; i++) {
        wf.step = i
        try {
          const result = await wf.steps[i].fn()
          wf.results.push(result)
        } catch { wf.status = 'failed'; return { success: false, results: wf.results } }
      }
      wf.status = 'completed'
      return { success: true, results: wf.results }
    },
    get(workflowId: string) {
      const wf = workflows.get(workflowId)
      return wf ? { id: wf.id, status: wf.status, step: wf.step } : undefined
    },
  })

  // 37. Context Info (P6.2)
  ctx.provide('contextInfo', {
    getInstructions() { return 'You are a helpful AI coding assistant.' },
    getTime() { return new Date().toISOString() },
    getWorkspace() { return '/' },
    assemble() {
      return `${this.getInstructions()}\n\nCurrent time: ${this.getTime()}\nWorkspace: ${this.getWorkspace()}`
    },
  })

  // 38. Commands (P6.2)
  const commandsMap = new Map<string, any>()
  ctx.provide('commands', {
    register(name: string, handler: any, description?: string) { commandsMap.set(name, { handler, description }) },
    execute(name: string, args?: any) { return commandsMap.get(name)?.handler(args) },
    list() { return [...commandsMap.entries()].map(([name, { description }]) => ({ name, description })) },
  })

  // 39. User Questions (P6.2)
  const pendingQuestions: any[] = []
  ctx.provide('userQuestions', {
    ask(question: string, options?: string[]) {
      const id = crypto.randomUUID()
      return new Promise(resolve => { pendingQuestions.push({ id, question, options, resolve }) })
    },
    getPending() { return pendingQuestions.map(({ id, question, options }) => ({ id, question, options })) },
    answer(id: string, answer: string) {
      const idx = pendingQuestions.findIndex(p => p.id === id)
      if (idx >= 0) { pendingQuestions[idx].resolve(answer); pendingQuestions.splice(idx, 1) }
    },
  })

  // 40. Notebook (P6.2)
  const notebooks = new Map<string, any>()
  ctx.provide('notebook', {
    create(title: string) { const id = crypto.randomUUID(); notebooks.set(id, { id, title, entries: [] }); return id },
    addEntry(notebookId: string, content: string) { notebooks.get(notebookId)?.entries.push(content) },
    get(notebookId: string) { return notebooks.get(notebookId) },
    list() { return [...notebooks.values()].map(({ id, title }) => ({ id, title })) },
    remove(notebookId: string) { notebooks.delete(notebookId) },
  })

  // 41. Squad (P6.2)
  const squads = new Map<string, any>()
  ctx.provide('squad', {
    create(name: string, members: string[]) { const id = crypto.randomUUID(); squads.set(id, { id, name, members }); return id },
    get(squadId: string) { return squads.get(squadId) },
    list() { return [...squads.values()].map(s => ({ id: s.id, name: s.name, memberCount: s.members.length })) },
    addMember(squadId: string, member: string) { const s = squads.get(squadId); if (s && !s.members.includes(member)) s.members.push(member) },
    removeMember(squadId: string, member: string) { const s = squads.get(squadId); if (s) s.members = s.members.filter((m: string) => m !== member) },
    disband(squadId: string) { squads.delete(squadId) },
  })

  // 42. Dynamic Cordis Runner (P6.3 — Self-Referential Runtime)
  const dynamicPlugins = new Map<string, any>()
  ctx.provide('dynamicCordisRunner', {
    inspect() {
      const plugins = [...dynamicPlugins.values()].map(p => ({ name: p.name, provides: p.provides || [], inject: p.inject || [], isDynamic: true }))
      const services = Object.keys(ctx).filter(k => !k.startsWith('_') && typeof (ctx as any)[k] !== 'undefined')
      return { plugins, services }
    },
    async define(name: string, code: string) {
      if (dynamicPlugins.has(name)) return { success: false, error: `Plugin "${name}" already defined` }
      try {
        const wrappedCode = `const module = { exports: {} }; const exports = module.exports; ${code}; return module.exports;`
        const compiled = new Function('ctx', wrappedCode)
        dynamicPlugins.set(name, { name, code, compiled })
        return { success: true }
      } catch (err: any) { return { success: false, error: err.message } }
    },
    async run(name: string, args?: any) {
      const p = dynamicPlugins.get(name)
      if (!p) return { success: false, error: `Plugin "${name}" not found` }
      try {
        const result = p.compiled(ctx)
        if (result && typeof result.apply === 'function') result.apply(ctx)
        return { success: true, result }
      } catch (err: any) { return { success: false, error: err.message } }
    },
    retract(name: string) {
      if (!dynamicPlugins.has(name)) return { success: false, error: `Plugin "${name}" not found` }
      dynamicPlugins.delete(name)
      return { success: true }
    },
    list() { return [...dynamicPlugins.keys()] },
  })

  // 43. Plugin Registry + Installer (P6.4)
  const pluginMeta = new Map<string, any>()
  const installedPlugins = new Set<string>()
  ctx.provide('pluginRegistry', {
    register(meta: any) { pluginMeta.set(meta.name, meta) },
    unregister(name: string) { pluginMeta.delete(name) },
    get(name: string) { return pluginMeta.get(name) },
    search(query: string, limit: number = 20) {
      const q = query.toLowerCase()
      return [...pluginMeta.values()].filter(p =>
        p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) ||
        p.keywords?.some((k: string) => k.toLowerCase().includes(q))
      ).slice(0, limit)
    },
    list() { return [...pluginMeta.values()] },
    listByCapability(cap: string) { return [...pluginMeta.values()].filter(p => p.provides?.includes(cap) || p.inject?.includes(cap)) },
  })

  // 注册已知插件元数据
  const knownPlugins = [
    { name: '@codem/llm', version: '1.0.0', description: 'LLM Service Definition', provides: ['llm'], inject: [], keywords: ['llm', 'ai'] },
    { name: '@codem/llm-deepseek', version: '1.0.0', description: 'DeepSeek LLM Provider', provides: ['llm'], inject: [], keywords: ['llm', 'deepseek'] },
    { name: '@codem/fs', version: '1.0.0', description: 'FileSystem Service Definition', provides: ['fs'], inject: [], keywords: ['fs', 'file'] },
    { name: '@codem/fs-local', version: '1.0.0', description: 'Local FileSystem Provider', provides: ['fs'], inject: [], keywords: ['fs', 'local'] },
    { name: '@codem/shell', version: '1.0.0', description: 'Shell Service Definition', provides: ['shell'], inject: [], keywords: ['shell'] },
    { name: '@codem/shell-local', version: '1.0.0', description: 'Local Shell Provider', provides: ['shell'], inject: [], keywords: ['shell'] },
    { name: '@codem/web', version: '1.0.0', description: 'Web Service Definition', provides: ['web'], inject: [], keywords: ['web'] },
    { name: '@codem/tool-fs', version: '1.0.0', description: 'File tools (read/write/glob/grep)', provides: [], inject: ['fs', 'tools'], keywords: ['tool', 'file'] },
    { name: '@codem/tool-bash', version: '1.0.0', description: 'Bash tool', provides: [], inject: ['shell', 'tools'], keywords: ['tool', 'bash'] },
    { name: '@codem/tool-web', version: '1.0.0', description: 'Web tools (search/fetch)', provides: [], inject: ['web', 'tools'], keywords: ['tool', 'web'] },
    { name: '@codem/extensions', version: '1.0.0', description: 'Self-Referential Runtime', provides: ['dynamicCordisRunner'], inject: [], keywords: ['runtime', 'dynamic'] },
    { name: '@codem/tool-cordis', version: '1.0.0', description: 'Cordis management tools', provides: [], inject: ['dynamicCordisRunner', 'tools'], keywords: ['tool', 'cordis'] },
  ]
  for (const meta of knownPlugins) { pluginMeta.set(meta.name, meta) }

  ctx.provide('pluginInstaller', {
    async install(name: string, _source?: string) {
      if (!pluginMeta.has(name)) return { success: false, error: `Plugin "${name}" not found` }
      installedPlugins.add(name)
      return { success: true }
    },
    async uninstall(name: string) {
      if (!installedPlugins.has(name)) return { success: false, error: `Plugin "${name}" not installed` }
      installedPlugins.delete(name)
      return { success: true }
    },
    async update(name: string) {
      if (!installedPlugins.has(name)) return { success: false, error: `Plugin "${name}" not installed` }
      return { success: true }
    },
    isInstalled(name: string) { return installedPlugins.has(name) },
  })

  // ===== 遗漏补齐: Preset/Bundle/SDK/ACP/Host/Client =====

  // 44. Preset
  const presets = new Map<string, any>()
  ctx.provide('preset', {
    load: async (name: string) => presets.get(name),
    save: async (name: string, config: any) => { presets.set(name, config) },
    list: () => [...presets.keys()].map(name => ({ name })),
    apply: async (name: string) => { console.log(`[preset] Applied: ${name}`) },
  })

  // 45. Bundle
  const installedBundles = new Set(['base'])
  ctx.provide('bundle', {
    install: async (name: string) => { installedBundles.add(name) },
    uninstall: async (name: string) => { installedBundles.delete(name) },
    list: () => ['base', 'headless', 'web-app'].map(name => ({ name, installed: installedBundles.has(name) })),
    getInstalled: () => [...installedBundles],
  })

  // 46. SDK
  const sdkServers = new Map<string, any>()
  ctx.provide('sdk', {
    startServer: async (_config?: any) => {
      const id = crypto.randomUUID()
      sdkServers.set(id, { id, status: 'running' })
      return id
    },
    stopServer: async (serverId: string) => {
      const s = sdkServers.get(serverId)
      if (s) s.status = 'stopped'
    },
    callMethod: async (_serverId: string, _method: string, _params?: any) => ({ result: 'ok' }),
    listServers: () => [...sdkServers.values()],
  })

  // 47. ACP
  const automations = new Map<string, any>()
  ctx.provide('acp', {
    registerAutomation: (name: string, config: any) => { automations.set(name, { name, config }) },
    unregisterAutomation: (name: string) => { automations.delete(name) },
    listAutomations: () => [...automations.values()],
    trigger: async (name: string, payload?: any) => {
      if (!automations.has(name)) throw new Error(`Automation "${name}" not found`)
      return { triggered: true, name, payload }
    },
  })

  // 48. Host
  ctx.provide('host', {
    _status: 'stopped',
    getEndpoint() { return 'http://localhost:8080' },
    getStatus() { return this._status },
    async start() { this._status = 'running'; console.log('[host] Started') },
    async stop() { this._status = 'stopped'; console.log('[host] Stopped') },
  })

  // 49. Client
  ctx.provide('client', {
    _connected: false,
    async connect(_endpoint: string) { this._connected = true; console.log('[client] Connected') },
    async disconnect() { this._connected = false; console.log('[client] Disconnected') },
    isConnected() { return this._connected },
    getCapabilities() { return ['chat', 'tools', 'sessions'] },
  })

  // Slot Registry
  // SlotsService 在构造函数中自动注册为 ctx.slots
  // 需要在 bridgePlugin 之外单独加载
}
