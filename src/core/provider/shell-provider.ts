// @ts-nocheck
/**
 * Shell Provider 插件 — 命令执行服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const shellProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('shell', {
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

  return dispose
}
