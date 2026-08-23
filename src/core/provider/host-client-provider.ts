// @ts-nocheck
/**
 * Host/Client Provider 插件 — 多端协同架构基础服务。
 *
 * ⚠️ R7 更新：bundle/sdk/acp/host/client 已拆分到独立 Provider 插件。
 * 本 Provider 现在只保留 pluginInstaller 服务。
 * 拆分后的独立 Provider：
 *   - @codem/bundle → bundleProvider
 *   - @codem/acp → acpProvider
 *   - @codem/host → hostProvider
 *   - @codem/remote-client → remoteClientProvider
 *   - @codem/sdk-protocol → sdkProtocolProvider（已有）
 *   - @codem/host-webserver → hostWebserverProvider（已有）
 */
import type { Plugin } from '../cordis/src/index.ts'

export const hostClientProvider: Plugin = (ctx: any) => {
  // ===== hostClient 服务 =====
  // 作为 hostClient 锚点服务注册到 Context。
  // 依赖链：hostClient → hostWebserver / sdkProtocol / hostPluginInventory
  // 在桌面模式下 hostWebserver 被禁用，但 hostClient 本身仍需注册，
  // 使 sdkProtocol 等非 Web 服务器插件可以正常激活。
  // 未来扩展 Web 模式时，可在 web bundle 中覆盖此 provider 提供远程客户端能力。
  const hostClientDispose = ctx.provide('hostClient', {
    mode: 'desktop',
    isRemote: false,
    // 未来 Web 模式下可扩展为远程连接
  })

  // ===== Plugin Installer（保留在 hostClient 中） =====
  const installedPlugins = new Set<string>()
  const installerDispose = ctx.provide('pluginInstaller', {
    async install(name: string, _source?: string): Promise<{ success: boolean; error?: string }> {
      installedPlugins.add(name)
      return { success: true }
    },
    async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
      if (!installedPlugins.has(name)) return { success: false, error: `Plugin "${name}" not installed` }
      installedPlugins.delete(name)
      return { success: true }
    },
    async update(name: string): Promise<{ success: boolean; error?: string }> {
      if (!installedPlugins.has(name)) return { success: false, error: `Plugin "${name}" not installed` }
      return { success: true }
    },
    isInstalled(name: string): boolean {
      return installedPlugins.has(name)
    },
  })

  return () => {
    hostClientDispose?.()
    installerDispose?.()
  }
}
