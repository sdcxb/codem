// @ts-nocheck
/**
 * @codem/shell — Shell 能力族 Service Definition
 *
 * 定义命令执行接口契约。Provider 包（shell-local, shell-sandbox, shell-remote）
 * 实现此接口并注册到 ctx.shell。Consumer 包通过 ctx.shell 执行命令。
 *
 * 替代原有 seam/types.ts 中的 ShellSeam。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface Shell {
  execute(command: string, cwd: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** Shell 服务（可替换 Provider） */
    shell: Shell
  }
}
