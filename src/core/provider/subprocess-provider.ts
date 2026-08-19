// @ts-nocheck
/**
 * @codem/subprocess — 子进程管理插件 (P1-7.7)
 *
 * 统一管理子进程的创建、监控和清理。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链）：
 * - 启动时：注册子进程管理服务，bash/pwsh 工具通过它创建进程
 * - 停止时：所有子进程被清理，正在执行的工具调用中断
 */
import type { Plugin } from '../cordis/src/index.ts'

class SubprocessManager {
  private processes: Map<string, any> = new Map()

  async spawn(id: string, command: string, args: string[], options?: any): Promise<any> {
    const { spawn } = await import('child_process')
    const proc = spawn(command, args, options)
    this.processes.set(id, proc)

    proc.on('exit', () => {
      this.processes.delete(id)
    })

    return proc
  }

  get(id: string): any {
    return this.processes.get(id) || null
  }

  kill(id: string, signal: string = 'SIGTERM'): boolean {
    const proc = this.processes.get(id)
    if (!proc) return false
    proc.kill(signal as any)
    return true
  }

  list(): string[] {
    return Array.from(this.processes.keys())
  }

  killAll(signal: string = 'SIGTERM') {
    for (const proc of this.processes.values()) {
      try { proc.kill(signal as any) } catch (e) { console.warn('[subprocess] kill failed', e) }
    }
    this.processes.clear()
  }
}

export const subprocessProvider: Plugin = (ctx: any) => {
  const manager = new SubprocessManager()

  const dispose = ctx.provide('subprocess', {
    async spawn(id: string, command: string, args: string[], options?: any) {
      return manager.spawn(id, command, args, options)
    },
    get(id: string) { return manager.get(id) },
    kill(id: string, signal?: string) { return manager.kill(id, signal || 'SIGTERM') },
    list() { return manager.list() },
    killAll(signal?: string) { return manager.killAll(signal || 'SIGTERM') },
  })

  return () => { manager.killAll() }
}
