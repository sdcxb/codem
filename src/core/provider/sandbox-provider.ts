// @ts-nocheck
/**
 * Sandbox Provider 插件 — 沙箱服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const sandboxProvider: Plugin = (ctx: any) => {
  const sandboxInstances = new Map<string, any>()

  const dispose = ctx.provide('sandbox', {
    create: async (config?: any) => {
      const id = crypto.randomUUID()
      const instance = {
        id,
        rootPath: config?.rootPath || '/tmp/sandbox-' + id,
        writablePaths: config?.writablePaths || [],
        env: config?.env || {},
        isActive: true,
      }
      sandboxInstances.set(id, instance)
      return instance
    },
    destroy: async (id: string) => {
      const inst = sandboxInstances.get(id)
      if (inst) { inst.isActive = false; sandboxInstances.delete(id) }
    },
    list: () => [...sandboxInstances.values()],
  })

  return dispose
}
