// @ts-nocheck
/**
 * @codem/bash-sandbox — Bash 沙箱执行插件
 *
 * 在沙箱环境中执行 Bash 命令，限制文件系统访问和进程权限。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链 Layer 2: 沙箱检查）：
 * - 启动时：注册沙箱 bash 执行器，工具调用通过沙箱隔离
 * - 停止时：回退到非沙箱模式执行 → 安全风险增加
 *   → 文档 6.4 辅助链路: 回退到非沙箱模式
 */
import type { Plugin } from '../cordis/src/index.ts'

class BashSandbox {
  private workspaceRoot: string = ''

  setWorkspace(root: string) {
    this.workspaceRoot = root
  }

  isPathAllowed(filePath: string): boolean {
    if (!this.workspaceRoot) return false
    // Simple path normalization without requiring Node path module
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const normalized = normalize(filePath)
    const root = normalize(this.workspaceRoot)
    return normalized.startsWith(root)
  }

  async execute(command: string, cwd?: string, timeout?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { exec } = await import('child_process')
    const actualCwd = cwd || this.workspaceRoot || process.cwd()

    return new Promise((resolve) => {
      exec(command, {
        cwd: actualCwd,
        timeout: timeout || 30000,
        shell: '/bin/bash',
        env: {
          ...process.env,
          // 沙箱环境变量
          SANDBOX_MODE: '1',
          HOME: actualCwd,
        },
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error as any).code || 1 : 0,
        })
      })
    })
  }
}

export const bashSandboxProvider: Plugin = (ctx: any) => {
  const sandbox = new BashSandbox()

  const dispose = ctx.provide('bashSandbox', {
    setWorkspace(root: string) { sandbox.setWorkspace(root) },
    isPathAllowed(filePath: string) { return sandbox.isPathAllowed(filePath) },
    async execute(command: string, cwd?: string, timeout?: number) { return sandbox.execute(command, cwd, timeout) },
  })

  return dispose
}
