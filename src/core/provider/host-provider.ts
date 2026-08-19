// @ts-nocheck
/**
 * @codem/host — Host 服务插件（从 hostClient 拆分）
 *
 * 提供本地 Host 服务管理。
 * 接入 Tauri sidecar 或本地 HTTP server。
 *
 * 功能链路融入（链路 F: Host/Client 链 → Host 端）：
 * - 启动时：注册 host 服务，可启动/停止本地 Host
 * - 停止时：Host 停止运行
 */
import type { Plugin } from '../cordis/src/index.ts'

class HostService {
  private status: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped'
  private port: number = 0
  private config: any = null

  getEndpoint(): string {
    return this.port > 0 ? `http://localhost:${this.port}` : 'http://localhost:8080'
  }

  getStatus(): string { return this.status }
  getPort(): number { return this.port }

  async start(config?: any): Promise<{ success: boolean; port?: number; error?: string }> {
    this.config = config
    this.status = 'starting'

    try {
      // 如果 hostWebserver 服务可用，委托给它
      const webserver = (globalThis as any).__codemCtx?.get?.('hostWebserver')
      if (webserver) {
        const port = await webserver.start(config?.port)
        this.port = port
        this.status = 'running'
        console.log(`[host] Started on port ${port} (via hostWebserver)`)
        return { success: true, port }
      }

      // 尝试 Tauri sidecar
      const tauri = (window as any)?.__TAURI__
      if (tauri?.shell?.Command) {
        const cmd = tauri.shell.Command.sidecar('bin/codem-host', ['--port', String(config?.port || 8080)])
        await cmd.spawn()
        this.port = config?.port || 8080
        this.status = 'running'
        console.log(`[host] Started Tauri sidecar on port ${this.port}`)
        return { success: true, port: this.port }
      }

      // 无可用 Host 后端
      this.status = 'stopped'
      return { success: false, error: 'No host backend available' }
    } catch (err: any) {
      this.status = 'stopped'
      return { success: false, error: err.message }
    }
  }

  async stop(): Promise<void> {
    this.status = 'stopping'
    try {
      const webserver = (globalThis as any).__codemCtx?.get?.('hostWebserver')
      if (webserver) {
        await webserver.stop()
      }
    } catch (e) { console.warn('[host-provider.ts]', e) }
    this.status = 'stopped'
    this.port = 0
    console.log('[host] Stopped')
  }
}

export const hostProvider: Plugin = (ctx: any) => {
  const service = new HostService()
  ;(globalThis as any).__codemCtx = ctx

  const dispose = ctx.provide('host', {
    _active: true,
    getEndpoint: () => service.getEndpoint(),
    getStatus: () => service.getStatus(),
    getPort: () => service.getPort(),
    start: (config?: any) => service.start(config),
    stop: () => service.stop(),
  })

  // Composite dispose — stop host service on unload
  const compositeDispose = () => {
    service.stop().catch(() => {})
    dispose()
  }
  return compositeDispose
}
