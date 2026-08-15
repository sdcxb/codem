// @ts-nocheck
/**
 * @codem/sandbox — 沙箱能力族 Service Definition
 *
 * 定义沙箱接口契约。沙箱为文件系统和 Shell 提供隔离层。
 * sandbox 是 fs 的 Consumer 而非 Provider（避免循环依赖）。
 * fs-sandbox 继承 fs-local 而非重新实现。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface Sandbox {
  /** 创建沙箱化执行环境 */
  create(config?: SandboxConfig): Promise<SandboxInstance>
  /** 销毁沙箱实例 */
  destroy(id: string): Promise<void>
  /** 列出活跃沙箱 */
  list(): SandboxInstance[]
}

export interface SandboxConfig {
  /** 沙箱根目录 */
  rootPath?: string
  /** 允许写的路径前缀 */
  writablePaths?: string[]
  /** 环境变量覆盖 */
  env?: Record<string, string>
  /** 超时（毫秒） */
  timeout?: number
}

export interface SandboxInstance {
  id: string
  rootPath: string
  writablePaths: string[]
  env: Record<string, string>
  isActive: boolean
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** 沙箱服务（可替换 Provider） */
    sandbox: Sandbox
  }
}
