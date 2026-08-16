// @ts-nocheck
/**
 * Host/Client Provider 插件 — 多端协同架构基础服务。
 *
 * 功能链：
 * - 上游：App.tsx → ctx.host.start() / ctx.client.connect(endpoint)
 *         第三方插件 → ctx.sdk.callMethod(serverId, method, params)
 *         PluginManager UI → ctx.bundle.install('headless')
 * - 下游：Tauri sidecar / 本地 HTTP server (Host)
 *         WebSocket / HTTP client (Client)
 *         PluginLoader.scan() (Bundle)
 *         RPC 通道 (SDK)
 *         AutomationManager (ACP)
 * - 接入点：App.tsx → 当需要远端部署/多端协同时接入
 *
 * 多端协同架构：
 *   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
 *   │  本地 App     │ ←──→   │  Host 服务   │  ←──→   │  远端 Client  │
 *   │  (Tauri)     │         │  (SDK+ACP)  │         │  (Browser)   │
 *   │ ctx.bundle   │         │ ctx.host     │         │ ctx.client   │
 *   │ ctx.preset   │         │ ctx.sdk      │         │              │
 *   │              │         │ ctx.acp      │         │              │
 *   └──────────────┘         └──────────────┘         └──────────────┘
 *
 * 当前为空壳实现。
 * 第一组（Bundle + ACP）：可立即接入现有功能链
 *   - Bundle → 接入 PluginLoader.scan()，扫描 native/landlock-run/packages/ 目录
 *   - ACP → 接入 AutomationManager，作为其 ctx 接口适配层
 * 第二组（SDK + Host + Client）：需要新建基础设施
 *   - 当前项目完全在 Tauri 本地运行，无远端部署场景
 *   - 暂不实现，保留接口定义，优先级 P5
 */
import type { Plugin } from '../cordis/src/index.ts'

export const hostClientProvider: Plugin = (ctx: any) => {
  // ===== Bundle =====
  const installedBundles = new Set<string>(['base'])
  const bundleDispose = ctx.provide('bundle', {
    async install(name: string): Promise<void> {
      // TODO: 调用 PluginLoader.scan(`native/landlock-run/packages/${name}/`)
      installedBundles.add(name)
      console.log(`[bundle] Installed: ${name}`)
    },
    async uninstall(name: string): Promise<void> {
      installedBundles.delete(name)
    },
    list(): Array<{ name: string; installed: boolean }> {
      const all = ['base', 'headless', 'web-app']
      return all.map(name => ({ name, installed: installedBundles.has(name) }))
    },
    getInstalled(): string[] {
      return [...installedBundles]
    },
  })

  // ===== SDK =====
  const sdkServers = new Map<string, { id: string; status: string }>()
  const sdkDispose = ctx.provide('sdk', {
    async startServer(_config?: any): Promise<string> {
      // TODO: 启动 RPC 通道（WebSocket/IPC）
      const id = crypto.randomUUID()
      sdkServers.set(id, { id, status: 'running' })
      return id
    },
    async stopServer(serverId: string): Promise<void> {
      const s = sdkServers.get(serverId)
      if (s) s.status = 'stopped'
    },
    async callMethod(_serverId: string, _method: string, _params?: any): Promise<any> {
      // TODO: 实现真实 RPC 调用
      return { result: 'ok' }
    },
    listServers(): Array<{ id: string; status: string }> {
      return [...sdkServers.values()]
    },
  })

  // ===== ACP (Automation Control Protocol) =====
  const automations = new Map<string, { name: string; config: any }>()
  const acpDispose = ctx.provide('acp', {
    registerAutomation(name: string, config: any): void {
      // TODO: 接入 automationManager.registerTrigger({ type: config.type, ...config })
      automations.set(name, { name, config })
    },
    unregisterAutomation(name: string): void {
      automations.delete(name)
    },
    listAutomations(): Array<{ name: string; config: any }> {
      return [...automations.values()]
    },
    async trigger(name: string, payload?: any): Promise<any> {
      // TODO: 接入 automationManager.fire(name, payload)
      if (!automations.has(name)) throw new Error(`Automation "${name}" not found`)
      return { triggered: true, name, payload }
    },
  })

  // ===== Host =====
  let hostStatus: 'starting' | 'running' | 'stopping' | 'stopped' = 'stopped'
  const hostDispose = ctx.provide('host', {
    getEndpoint(): string {
      return 'http://localhost:8080'
    },
    getStatus(): string {
      return hostStatus
    },
    async start(_config?: any): Promise<void> {
      // TODO: 启动 Tauri sidecar / 本地 HTTP server
      hostStatus = 'running'
      console.log('[host] Started')
    },
    async stop(): Promise<void> {
      hostStatus = 'stopped'
      console.log('[host] Stopped')
    },
  })

  // ===== Client =====
  let clientConnected = false
  const clientDispose = ctx.provide('client', {
    async connect(_endpoint: string): Promise<void> {
      // TODO: 实现 WebSocket / HTTP client 连接
      clientConnected = true
      console.log('[client] Connected')
    },
    async disconnect(): Promise<void> {
      clientConnected = false
      console.log('[client] Disconnected')
    },
    isConnected(): boolean {
      return clientConnected
    },
    getCapabilities(): string[] {
      return ['chat', 'tools', 'sessions']
    },
  })

  // ===== Plugin Installer =====
  const installedPlugins = new Set<string>()
  const installerDispose = ctx.provide('pluginInstaller', {
    async install(name: string, _source?: string): Promise<{ success: boolean; error?: string }> {
      // TODO: 从 pluginRegistry 获取元数据 → 验证依赖 → 加载代码 → ctx.plugin() 注册
      installedPlugins.add(name)
      return { success: true }
    },
    async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
      if (!installedPlugins.has(name)) return { success: false, error: `Plugin "${name}" not installed` }
      // TODO: 调用 PluginManagerService.disable(name) → 从 ctx 卸载
      installedPlugins.delete(name)
      return { success: true }
    },
    async update(name: string): Promise<{ success: boolean; error?: string }> {
      if (!installedPlugins.has(name)) return { success: false, error: `Plugin "${name}" not installed` }
      return { success: true }
    },
    isInstalled(name: string): boolean {
      return installedPlugins.has(name)
    },
  })

  // 返回聚合 disposer
  return () => {
    bundleDispose?.()
    sdkDispose?.()
    acpDispose?.()
    hostDispose?.()
    clientDispose?.()
    installerDispose?.()
  }
}
