// @ts-nocheck
/**
 * @codem/terminal-bash — Bash 终端插件
 *
 * 提供持久化的 Bash 终端会话，支持多终端管理。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链 → app.terminal）：
 * - 启动时：注册终端服务，UI 通过 ctx.get('terminalBash') 获取终端实例
 * - 停止时：终端不可用，UI 中 TerminalPanel 显示"终端服务不可用"
 */
import type { Plugin } from '../cordis/src/index.ts'

interface TerminalSession {
  id: string
  process: any | null
  cwd: string
  history: string[]
}

class TerminalBashManager {
  private sessions: Map<string, TerminalSession> = new Map()

  create(id: string, cwd?: string): TerminalSession {
    const session: TerminalSession = {
      id,
      process: null,
      cwd: cwd || process.cwd(),
      history: [],
    }
    this.sessions.set(id, session)
    return session
  }

  async start(id: string): Promise<TerminalSession | null> {
    const { spawn } = await import('child_process')
    const session = this.sessions.get(id)
    if (!session) return null

    session.process = spawn('/bin/bash', ['-i'], {
      cwd: session.cwd,
      env: { ...process.env, TERM: 'dumb' },
    })

    return session
  }

  get(id: string): TerminalSession | null {
    return this.sessions.get(id) || null
  }

  list(): TerminalSession[] {
    return Array.from(this.sessions.values())
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.process?.stdin) return false
    session.history.push(data)
    session.process.stdin.write(data)
    return true
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.process) return false
    session.process.kill('SIGTERM')
    session.process = null
    return true
  }

  destroy(id: string) {
    this.kill(id)
    this.sessions.delete(id)
  }

  destroyAll() {
    for (const id of this.sessions.keys()) {
      this.destroy(id)
    }
  }
}

export const terminalBashProvider: Plugin = (ctx: any) => {
  const manager = new TerminalBashManager()

  const dispose = ctx.provide('terminalBash', {
    create(id: string, cwd?: string) { return manager.create(id, cwd) },
    async start(id: string) { return manager.start(id) },
    get(id: string) { return manager.get(id) },
    list() { return manager.list() },
    write(id: string, data: string) { return manager.write(id, data) },
    kill(id: string) { return manager.kill(id) },
    destroy(id: string) { return manager.destroy(id) },
    destroyAll() { return manager.destroyAll() },
  })

  return () => { manager.destroyAll() }
}
