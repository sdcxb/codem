// @ts-nocheck
/**
 * @codem/remote-client — 远端 Client 插件（从 hostClient 拆分）
 *
 * 远端客户端连接服务，用于连接到 Host 服务。
 * 支持 WebSocket 和 HTTP 两种连接模式。
 *
 * 功能链路融入（链路 F: Host/Client 链 → Client 端）：
 * - 启动时：注册 client 服务，可连接到远端 Host
 * - 停止时：断开连接
 */
import type { Plugin } from '../cordis/src/index.ts'

class RemoteClientService {
  private connected = false
  private endpoint: string = ''
  private ws: WebSocket | null = null
  private capabilities: string[] = []
  private listeners: Array<(event: string, data: any) => void> = []

  isConnected(): boolean { return this.connected }
  getEndpoint(): string { return this.endpoint }
  getCapabilities(): string[] { return this.capabilities }

  async connect(endpoint: string): Promise<{ success: boolean; error?: string }> {
    this.endpoint = endpoint

    try {
      // 尝试 WebSocket 连接
      const wsEndpoint = endpoint.replace(/^http/, 'ws')
      this.ws = new WebSocket(wsEndpoint)

      await new Promise((resolve, reject) => {
        // FIX: 连接成功后清理超时 timer（之前 setTimeout 不清理 — 5s 后对
        // 已 resolve 的 Promise 再 reject，且 timer 直到触发才释放）。
        const timer = setTimeout(() => reject(new Error('Connection timeout')), 5000)
        this.ws!.onopen = () => { clearTimeout(timer); resolve() }
        this.ws!.onerror = (e) => { clearTimeout(timer); reject(new Error('WebSocket error')) }
      })

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          this.notify('message', data)
        } catch (e) { console.warn('[remote-client-provider.ts]', e) }
      }

      this.ws.onclose = () => {
        this.connected = false
        this.notify('disconnected', { endpoint })
      }

      // 获取远端能力
      this.capabilities = await this.getRemoteCapabilities()

      this.connected = true
      this.notify('connected', { endpoint })
      console.log(`[client] Connected to ${endpoint}`)
      return { success: true }
    } catch (err: any) {
      this.connected = false
      this.ws = null
      return { success: false, error: err.message }
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.notify('disconnected', { endpoint: this.endpoint })
    console.log('[client] Disconnected')
  }

  async send(data: any): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private async getRemoteCapabilities(): Promise<string[]> {
    try {
      const response = await fetch(`${this.endpoint}/api/capabilities`)
      const data = await response.json()
      return data.capabilities || ['chat', 'tools', 'sessions']
    } catch {
      return ['chat']
    }
  }

  subscribe(listener: (event: string, data: any) => void) {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }

  private notify(event: string, data: any) {
    this.listeners.forEach(l => { try { l(event, data) } catch (e) { console.warn('[remote-client-provider.ts]', e) } })
  }
}

export const remoteClientProvider: Plugin = (ctx: any) => {
  const service = new RemoteClientService()

  const dispose = ctx.provide('client', {
    isConnected: () => service.isConnected(),
    getEndpoint: () => service.getEndpoint(),
    getCapabilities: () => service.getCapabilities(),
    connect: (endpoint: string) => service.connect(endpoint),
    disconnect: () => service.disconnect(),
    send: (data: any) => service.send(data),
    subscribe: (listener: any) => service.subscribe(listener),
  })

  return dispose
}
