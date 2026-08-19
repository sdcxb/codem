// @ts-nocheck
/**
 * @codem/cli — CLI 入口插件
 *
 * 提供命令行接口，支持在终端中运行 Codem。
 * 通过 Node.js child_process 或 Tauri sidecar 模式运行。
 *
 * 功能链路融入：
 * - 启动时：注册 CLI 服务，检测并解析命令行参数
 * - 停止时：CLI 不可用
 *
 * 支持的命令：
 *   codem chat [message]       — 发送消息给 Agent
 *   codem session list         — 列出会话
 *   codem session create       — 创建会话
 *   codem plugin list          — 列出插件
 *   codem plugin toggle <name> — 启停插件
 *   codem tool list             — 列出工具
 *   codem tool call <name>     — 调用工具
 *   codem status                — 系统状态
 */
import type { Plugin } from '../cordis/src/index.ts'

class CliService {
  private commands: Map<string, { description: string; handler: (args: string[], ctx: any) => Promise<any> }> = new Map()
  private isStarted = false

  constructor() {
    // 注册内置命令
    this.register('chat', '发送消息给 Agent', async (args, ctx) => {
      const message = args.join(' ')
      if (!message) return { error: 'Message is required' }
      const session = ctx.get('session')
      if (!session) return { error: 'Session service not available' }
      // 创建或获取默认会话
      const sessions = await session.list()
      let sessionId = sessions[0]?.id
      if (!sessionId) {
        const newSession = await session.create({ title: 'CLI Session' })
        sessionId = newSession.id
      }
      const msg = await session.addMessage(sessionId, { role: 'user', content: message })
      return { messageId: msg?.id, sessionId, message }
    })

    this.register('session list', '列出所有会话', async (_args, ctx) => {
      const session = ctx.get('session')
      if (!session) return { error: 'Session service not available' }
      return await session.list()
    })

    this.register('session create', '创建新会话', async (args, ctx) => {
      const session = ctx.get('session')
      if (!session) return { error: 'Session service not available' }
      const title = args[0] || 'New Session'
      return await session.create({ title })
    })

    this.register('plugin list', '列出已安装插件', async (_args, ctx) => {
      const registry = ctx.get('pluginRegistry')
      if (!registry) return { error: 'Plugin registry not available' }
      return registry.list().map((p: any) => ({
        name: p.name, version: p.version, category: p.category, status: p.status || 'enabled',
      }))
    })

    this.register('plugin toggle', '启停插件', async (args, ctx) => {
      const name = args[0]
      if (!name) return { error: 'Plugin name is required' }
      const pluginManager = ctx.get('pluginManager')
      if (!pluginManager) return { error: 'Plugin manager not available' }
      const state = pluginManager.getPluginState(name)
      if (!state) return { error: `Plugin "${name}" not found` }
      if (state.status === 'enabled') {
        return await pluginManager.disable(name)
      } else {
        return await pluginManager.enable(name)
      }
    })

    this.register('tool list', '列出可用工具', async (_args, ctx) => {
      const tools = ctx.get('tools')
      if (!tools) return { error: 'Tools service not available' }
      return await tools.list()
    })

    this.register('tool call', '调用工具', async (args, ctx) => {
      const toolName = args[0]
      if (!toolName) return { error: 'Tool name is required' }
      const tools = ctx.get('tools')
      if (!tools) return { error: 'Tools service not available' }
      // 解析工具参数（简单的 JSON 解析）
      let toolArgs = {}
      if (args[1]) {
        try { toolArgs = JSON.parse(args[1]) } catch { toolArgs = { input: args[1] } }
      }
      return await tools.call(toolName, toolArgs)
    })

    this.register('status', '获取系统状态', async (_args, ctx) => {
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
  }

  register(command: string, description: string, handler: (args: string[], ctx: any) => Promise<any>) {
    this.commands.set(command, { description, handler })
  }

  listCommands(): Array<{ command: string; description: string }> {
    return [...this.commands.entries()].map(([command, { description }]) => ({ command, description }))
  }

  async execute(commandLine: string, ctx: any): Promise<any> {
    const parts = commandLine.trim().split(/\s+/)
    // 尝试匹配多词命令（如 "session list"）
    let matchedCommand = ''
    let args: string[] = []

    for (const [cmd] of this.commands) {
      const cmdParts = cmd.split(' ')
      if (parts.length >= cmdParts.length &&
          cmdParts.every((p, i) => parts[i] === p)) {
        matchedCommand = cmd
        args = parts.slice(cmdParts.length)
        break
      }
    }

    if (!matchedCommand) {
      return { error: `Unknown command: ${commandLine}. Use 'codem help' to list commands.` }
    }

    const entry = this.commands.get(matchedCommand)!
    try {
      return await entry.handler(args, ctx)
    } catch (err: any) {
      return { error: err.message }
    }
  }

  /**
   * 检测是否有命令行参数传入
   */
  static detectArgs(): string[] | null {
    // 浏览器环境：检查 URL 参数
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const cmd = params.get('cmd')
      if (cmd) return cmd.split(/\s+/)
    }
    // Node.js 环境
    if (typeof process !== 'undefined' && process.argv) {
      const args = process.argv.slice(2)
      if (args.length > 0) return args
    }
    return null
  }
}

export const cliProvider: Plugin = (ctx: any) => {
  const cli = new CliService()

  // 检测是否有命令行参数
  const args = CliService.detectArgs()
  if (args && args.length > 0) {
    const commandLine = args.join(' ')
    console.log(`[CLI] Detected command: ${commandLine}`)
    // 延迟执行，等待服务就绪
    setTimeout(async () => {
      try {
        const result = await cli.execute(commandLine, ctx)
        console.log('[CLI] Result:', JSON.stringify(result, null, 2))
      } catch (err) {
        console.error('[CLI] Error:', err)
      }
    }, 2000)
  }

  const dispose = ctx.provide('cli', {
    listCommands: () => cli.listCommands(),
    execute: (commandLine: string) => cli.execute(commandLine, ctx),
    register: (command: string, description: string, handler: any) => cli.register(command, description, handler),
  })

  return dispose
}
