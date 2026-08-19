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
    installerDispose?.()
  }
}
