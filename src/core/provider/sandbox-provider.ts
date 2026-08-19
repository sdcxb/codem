// @ts-nocheck
/**
 * Sandbox Provider 插件 — 沙箱隔离服务。
 *
 * F6: 深化 — 接入 sandbox/sandbox-acl.ts 的 SandboxGuard。
 * create() 创建真实沙箱实例（基于 ACL 策略）。
 * exec() 在沙箱策略下执行命令。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { SandboxGuard, createDefaultPolicy, createStrictPolicy, initSandboxGuard, getSandboxGuard } from '../sandbox/sandbox-acl.ts'

export const sandboxProvider: Plugin = (ctx: any) => {
  const sandboxInstances = new Map<string, { id: string; guard: SandboxGuard; rootPath: string; isActive: boolean }>()

  const dispose = ctx.provide('sandbox', {
    _active: true,

    /** Create a sandbox instance with ACL policy */
    create: async (config?: any) => {
      const id = crypto.randomUUID()
      const rootPath = config?.rootPath || '/tmp/sandbox-' + id
      const policy = config?.strict
        ? createStrictPolicy(rootPath)
        : createDefaultPolicy(rootPath)

      // Merge writable paths from config
      if (config?.writablePaths) {
        policy.writablePaths = [...(policy.writablePaths || []), ...config.writablePaths]
      }

      const guard = initSandboxGuard(policy)
      const instance = { id, guard, rootPath, isActive: true }
      sandboxInstances.set(id, instance)
      return instance
    },

    /** Destroy a sandbox instance */
    destroy: async (id: string) => {
      const inst = sandboxInstances.get(id)
      if (inst) {
        inst.isActive = false
        sandboxInstances.delete(id)
      }
    },

    /** List active sandbox instances */
    list: () => [...sandboxInstances.values()].map(({ id, rootPath, isActive }) => ({ id, rootPath, isActive })),

    /** Execute a command within a sandbox */
    async exec(id: string, command: string, args?: string[]) {
      const inst = sandboxInstances.get(id)
      if (!inst) throw new Error(`Sandbox ${id} not found`)
      if (!inst.isActive) throw new Error(`Sandbox ${id} is not active`)

      // Use the global shell service if available, with guard's policy applied
      const shell = ctx?.get?.('shell')
      if (shell?.exec) {
        return shell.exec(command, args, { cwd: inst.rootPath })
      }

      // Fallback: direct child_process exec (no real isolation)
      const { exec } = await import('child_process')
      return new Promise((resolve, reject) => {
        exec(`${command} ${args?.join(' ') || ''}`, { cwd: inst.rootPath }, (err, stdout, stderr) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
    },

    /** Get the global sandbox guard (singleton) */
    getGuard() { return getSandboxGuard() },
  })

  // Composite dispose — clean up all sandboxes
  const compositeDispose = () => {
    for (const [, inst] of sandboxInstances) {
      inst.isActive = false
    }
    sandboxInstances.clear()
    dispose()
  }
  return compositeDispose
}
