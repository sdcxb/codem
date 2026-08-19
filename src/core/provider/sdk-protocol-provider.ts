// @ts-nocheck
/**
 * @codem/sdk-protocol — SDK 协议插件 (P2-7.13)
 *
 * 定义外部 SDK 与宿主之间的通信协议（JSON-RPC over WebSocket）。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链 → 外部客户端接入）：
 * - 启动时：注册 SDK 协议服务，外部客户端可通过协议连接
 * - 停止时：协议不可用，外部客户端无法连接
 */
import type { Plugin } from '../cordis/src/index.ts'

interface SdkClient {
  id: string
  send: (message: any) => void
  close: () => void
}

class SdkProtocol {
  private clients: Map<string, SdkClient> = new Map()
  private handlers: Map<string, (params: any, client: SdkClient) => any> = new Map()

  registerClient(id: string, client: SdkClient) {
    this.clients.set(id, client)
  }

  removeClient(id: string) {
    this.clients.delete(id)
  }

  registerHandler(method: string, handler: (params: any, client: SdkClient) => any) {
    this.handlers.set(method, handler)
  }

  async handleMessage(clientId: string, message: any): Promise<any> {
    const client = this.clients.get(clientId)
    if (!client) throw new Error('Client not found')

    const handler = this.handlers.get(message.method)
    if (!handler) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
    }

    try {
      const result = await handler(message.params, client)
      return { jsonrpc: '2.0', id: message.id, result }
    } catch (err: any) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: err.message } }
    }
  }

  broadcast(method: string, params: any) {
    const message = { jsonrpc: '2.0', method, params }
    for (const client of this.clients.values()) {
      try { client.send(message) } catch (e) { console.warn('[sdk-protocol-provider.ts]', e) }
    }
  }

  listClients() { return Array.from(this.clients.keys()) }
  listMethods() { return Array.from(this.handlers.keys()) }
}

export const sdkProtocolProvider: Plugin = (ctx: any) => {
  const protocol = new SdkProtocol()

  // ===== 自动注册核心 JSON-RPC 方法处理器，接入 Cordis 服务 =====

  // chat.send — 发送消息给 Agent
  protocol.registerHandler('chat.send', async (params: any) => {
    const session = ctx.get('session')
    if (!session) throw new Error('Session service not available')
    const msg = await session.addMessage(params.sessionId, { role: 'user', content: params.message })
    return { messageId: msg?.id, sessionId: params.sessionId }
  })

  // chat.history — 获取对话历史
  protocol.registerHandler('chat.history', async (params: any) => {
    const session = ctx.get('session')
    if (!session) throw new Error('Session service not available')
    return await session.getMessages(params.sessionId)
  })

  // session.list — 列出所有会话
  protocol.registerHandler('session.list', async () => {
    const session = ctx.get('session')
    if (!session) throw new Error('Session service not available')
    return await session.list()
  })

  // session.create — 创建新会话
  protocol.registerHandler('session.create', async (params: any) => {
    const session = ctx.get('session')
    if (!session) throw new Error('Session service not available')
    return await session.create(params)
  })

  // session.delete — 删除会话
  protocol.registerHandler('session.delete', async (params: any) => {
    const session = ctx.get('session')
    if (!session) throw new Error('Session service not available')
    await session.delete(params.sessionId)
    return { success: true }
  })

  // tools.list — 列出可用工具
  protocol.registerHandler('tools.list', async () => {
    const tools = ctx.get('tools')
    if (!tools) throw new Error('Tools service not available')
    return await tools.list()
  })

  // tools.call — 调用工具
  protocol.registerHandler('tools.call', async (params: any) => {
    const tools = ctx.get('tools')
    if (!tools) throw new Error('Tools service not available')
    return await tools.call(params.toolName, params.args)
  })

  // plugins.list — 列出已安装插件
  protocol.registerHandler('plugins.list', async () => {
    const registry = ctx.get('pluginRegistry')
    if (!registry) throw new Error('Plugin registry not available')
    return registry.list().map((p: any) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      category: p.category,
      status: p.status || 'enabled',
    }))
  })

  // plugins.toggle — 启停插件
  protocol.registerHandler('plugins.toggle', async (params: any) => {
    const pluginManager = ctx.get('pluginManager')
    if (!pluginManager) throw new Error('Plugin manager not available')
    const state = pluginManager.getPluginState(params.name)
    if (!state) throw new Error(`Plugin "${params.name}" not found`)
    if (state.status === 'enabled') {
      return await pluginManager.disable(params.name)
    } else {
      return await pluginManager.enable(params.name)
    }
  })

  // settings.get — 获取设置
  protocol.registerHandler('settings.get', async (params: any) => {
    const settings = ctx.get('settings')
    if (!settings) throw new Error('Settings service not available')
    return await settings.get(params.key)
  })

  // settings.set — 设置配置
  protocol.registerHandler('settings.set', async (params: any) => {
    const settings = ctx.get('settings')
    if (!settings) throw new Error('Settings service not available')
    await settings.set(params.key, params.value)
    return { success: true }
  })

  // status — 获取系统状态
  protocol.registerHandler('status', async () => {
    return {
      version: '1.0.0',
      services: {
        llm: !!ctx.get('llm'),
        session: !!ctx.get('session'),
        tools: !!ctx.get('tools'),
        storage: !!ctx.get('storage'),
      },
      timestamp: Date.now(),
    }
  })

  const dispose = ctx.provide('sdkProtocol', {
    registerClient(id: string, client: any) { protocol.registerClient(id, client) },
    removeClient(id: string) { protocol.removeClient(id) },
    registerHandler(method: string, handler: any) { protocol.registerHandler(method, handler) },
    async handleMessage(clientId: string, message: any) { return protocol.handleMessage(clientId, message) },
    broadcast(method: string, params: any) { protocol.broadcast(method, params) },
    listClients() { return protocol.listClients() },
    listMethods() { return protocol.listMethods() },
  })

  return dispose
}
