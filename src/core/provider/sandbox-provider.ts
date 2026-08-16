// @ts-nocheck
/**
 * Sandbox Provider 插件 — 沙箱隔离服务。
 *
 * ⚠️ STUB — 无真实实现源。当前仅 Map CRUD，无真实隔离。
 *
 * 开发计划：
 * - 将 native/landlock-run/ 的 Landlock（Linux）/Seatbelt（macOS）接入 ctx
 * - create() 创建真实沙箱实例（文件系统隔离 + 进程限制）
 * - destroy() 销毁沙箱实例，清理资源
 * - list() 列出活跃沙箱实例
 * - exec() 在指定沙箱中执行命令
 * - 支持 Docker/containerd 作为远程沙箱后端
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
