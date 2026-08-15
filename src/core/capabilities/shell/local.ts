// @ts-nocheck
/**
 * @codem/shell-local — 本地 Shell Provider
 *
 * 使用 Tauri 的终端 API 执行命令。
 * 包装现有 seam/local-shell-provider.ts 的实现。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { Shell } from './index.ts'

export class LocalShell implements Shell {
  constructor(private ctx: Context) {}

  async execute(command: string, cwd: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { invoke } = (window as any).__TAURI__?.core || {}
    if (invoke) {
      try {
        const result = await invoke('execute_command', { command, cwd, timeoutMs: timeoutMs || 30000 })
        return result as { stdout: string; stderr: string; exitCode: number }
      } catch (err: any) {
        return { stdout: '', stderr: String(err), exitCode: 1 }
      }
    }
    // Fallback: try Node.js child_process (in dev mode)
    try {
      const { execSync } = await import('child_process')
      const output = execSync(command, { cwd, timeout: timeoutMs || 30000, encoding: 'utf-8' })
      return { stdout: output, stderr: '', exitCode: 0 }
    } catch (err: any) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }
}

export const inject = [] as const
export const provide = ['shell'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('shell', new LocalShell(ctx))
}
