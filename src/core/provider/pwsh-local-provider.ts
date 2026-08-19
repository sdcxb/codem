// @ts-nocheck
/**
 * @codem/pwsh-local — PowerShell 本地执行插件
 *
 * 提供 Windows PowerShell 命令执行能力。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链）：
 * - 启动时：注册 pwsh 工具到 ToolRegistry，LLM 可调用 PowerShell
 * - 停止时：pwsh 工具不可用，LLM 尝试使用 bash 工具替代
 *   → 文档 6.4 辅助链路: 工具执行降级
 */
import type { Plugin } from '../cordis/src/index.ts'

export const pwshLocalProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('pwshLocal', {
    async execute(command: string, cwd?: string, timeout?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const { exec } = await import('child_process')
      return new Promise((resolve) => {
        const proc = exec(command, {
          cwd: cwd || process.cwd(),
          timeout: timeout || 30000,
          shell: 'powershell.exe',
        }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: error ? (error as any).code || 1 : 0,
          })
        })
      })
    },

    async executeStreaming(command: string, cwd?: string) {
      const { exec } = await import('child_process')
      return exec(command, {
        cwd: cwd || process.cwd(),
        shell: 'powershell.exe',
      })
    },
  })

  return dispose
}
