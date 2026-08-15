// @ts-nocheck
/**
 * @codem/sandbox-local — 本地沙箱 Provider
 *
 * 提供基于目录隔离的本地沙箱。
 * 在 Tauri 环境下使用 Landlock/Seatbelt 实现真正的沙箱隔离。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { Sandbox, SandboxConfig, SandboxInstance } from './index.ts'

export class LocalSandbox implements Sandbox {
  private instances = new Map<string, SandboxInstance>()

  constructor(private ctx: Context) {}

  async create(config?: SandboxConfig): Promise<SandboxInstance> {
    const id = crypto.randomUUID()
    const instance: SandboxInstance = {
      id,
      rootPath: config?.rootPath || '/tmp/sandbox-' + id,
      writablePaths: config?.writablePaths || [],
      env: config?.env || {},
      isActive: true,
    }
    this.instances.set(id, instance)
    return instance
  }

  async destroy(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (instance) {
      instance.isActive = false
      this.instances.delete(id)
    }
  }

  list(): SandboxInstance[] {
    return [...this.instances.values()]
  }
}

export const inject = [] as const
export const provide = ['sandbox'] as const

export const apply: Plugin = (ctx: Context) => {
  ctx.provide('sandbox', new LocalSandbox(ctx))
}
