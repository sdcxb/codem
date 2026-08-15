// @ts-nocheck
/**
 * @codem/tool-bash — Bash 工具 Consumer
 *
 * 通过 ctx.shell 消费 Shell 能力，注册 bash 工具。
 * 不直接依赖任何 Provider，切换 Provider 时无需修改此文件。
 */
import { defineTool, useCtx } from '../../consumer/index.ts'

export const inject = ['shell', 'tools'] as const

export function apply() {
  const ctx = useCtx()

  defineTool({
    name: 'bash',
    description: 'Execute a bash command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
    requirePermission: true,
    async execute({ command, cwd, timeout }: { command: string; cwd?: string; timeout?: number }) {
      const result = await ctx.shell.execute(command, cwd || '.', timeout)
      const output = []
      if (result.stdout) output.push(result.stdout)
      if (result.stderr) output.push(result.stderr)
      return output.join('\n') || '(no output)'
    },
  })
}
