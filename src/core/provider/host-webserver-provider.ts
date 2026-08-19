// @ts-nocheck
/**
 * @codem/host-webserver — Web 服务器插件 (P2-7.13)
 *
 * 提供 HTTP Web 服务器能力，支持远程访问和 API 暴露。
 *
 * 功能链路融入：
 * - 启动时：注册 Web 服务器服务，监听 HTTP 请求
 * - 停止时：Web 服务器关闭，远程连接断开
 */
import type { Plugin } from '../cordis/src/index.ts'

class HostWebserver {
  private server: any = null
  private port: number = 0
  private handlers: Map<string, (req: any, res: any) => void> = new Map()

  async start(port: number = 0): Promise<number> {
    const { createServer } = await import('http')
    return new Promise((resolve, reject) => {
      this.server = createServer((req: any, res: any) => {
        const handler = this.handlers.get(req.url || '/')
        if (handler) {
          handler(req, res)
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      this.server.listen(port, () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve(this.port)
      })

      this.server.on('error', reject)
    })
  }

  registerHandler(path: string, handler: (req: any, res: any) => void) {
    this.handlers.set(path, handler)
  }

  unregisterHandler(path: string) {
    this.handlers.delete(path)
  }

  getPort() { return this.port }
  isRunning() { return this.server !== null }

  stop() {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null
          this.port = 0
          resolve()
        })
      } else {
        resolve()
      }
    })
  }
}

export const hostWebserverProvider: Plugin = (ctx: any) => {
  const webserver = new HostWebserver()

  // ===== 自动注册核心 HTTP 路由，接入 Cordis 服务 =====

  // GET /api/status — 系统状态
  webserver.registerHandler('/api/status', (req: any, res: any) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      version: '1.0.0',
      services: {
        llm: !!ctx.get('llm'),
        session: !!ctx.get('session'),
        tools: !!ctx.get('tools'),
        storage: !!ctx.get('storage'),
      },
      timestamp: Date.now(),
    }))
  })

  // GET /api/sessions — 列出会话
  webserver.registerHandler('/api/sessions', async (req: any, res: any) => {
    try {
      const session = ctx.get('session')
      if (!session) throw new Error('Session service not available')
      const sessions = await session.list()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(sessions))
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // GET /api/plugins — 列出插件
  webserver.registerHandler('/api/plugins', (req: any, res: any) => {
    try {
      const registry = ctx.get('pluginRegistry')
      if (!registry) throw new Error('Plugin registry not available')
      const plugins = registry.list().map((p: any) => ({
        name: p.name, version: p.version, description: p.description, category: p.category,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(plugins))
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // GET /api/tools — 列出工具
  webserver.registerHandler('/api/tools', async (req: any, res: any) => {
    try {
      const tools = ctx.get('tools')
      if (!tools) throw new Error('Tools service not available')
      const list = await tools.list()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(list))
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // GET /api/settings — 获取设置
  webserver.registerHandler('/api/settings', async (req: any, res: any) => {
    try {
      const settings = ctx.get('settings')
      if (!settings) throw new Error('Settings service not available')
      const all = await settings.getAll?.() || {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(all))
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // WebSocket 升级端点 — 接入 sdkProtocol
  webserver.registerHandler('/ws', (req: any, res: any) => {
    try {
      const sdkProtocol = ctx.get('sdkProtocol')
      if (sdkProtocol) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ws: true, methods: sdkProtocol.listMethods() }))
      } else {
        res.writeHead(503)
        res.end('SDK Protocol not available')
      }
    } catch (err: any) {
      res.writeHead(500)
      res.end(err.message)
    }
  })

  const dispose = ctx.provide('hostWebserver', {
    async start(port?: number) { return webserver.start(port) },
    registerHandler(path: string, handler: any) { webserver.registerHandler(path, handler) },
    unregisterHandler(path: string) { webserver.unregisterHandler(path) },
    getPort() { return webserver.getPort() },
    isRunning() { return webserver.isRunning() },
    async stop() { return webserver.stop() },
  })

  return () => { webserver.stop() }
}
