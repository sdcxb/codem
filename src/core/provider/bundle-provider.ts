// @ts-nocheck
/**
 * @codem/bundle — Bundle 管理插件（从 hostClient 拆分）
 *
 * 管理插件包的安装、卸载、列表。
 * 接入 PluginLoader.scan() 扫描 native/landlock-run/packages/ 目录。
 *
 * 功能链路融入（链路 F: Host/Client 链 → Bundle 管理）：
 * - 启动时：注册 bundle 服务，PluginManager UI 可通过 ctx.get('bundle') 管理
 * - 停止时：bundle 管理不可用
 */
import type { Plugin } from '../cordis/src/index.ts'

class BundleService {
  private installedBundles = new Set<string>(['base'])
  private availableBundles = ['base', 'headless', 'web-app']

  async install(name: string): Promise<{ success: boolean; error?: string }> {
    // 扫描 native/landlock-run/packages/ 目录
    try {
      // 通过 PluginLoader 扫描
      const pluginLoader = (globalThis as any).__codemPluginLoader
      if (pluginLoader) {
        await pluginLoader.scanBundle?.(`native/landlock-run/packages/${name}/`)
      }
      this.installedBundles.add(name)
      console.log(`[bundle] Installed: ${name}`)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.installedBundles.has(name)) {
      return { success: false, error: `Bundle "${name}" not installed` }
    }
    if (name === 'base') {
      return { success: false, error: 'Cannot uninstall base bundle' }
    }
    this.installedBundles.delete(name)
    console.log(`[bundle] Uninstalled: ${name}`)
    return { success: true }
  }

  list(): Array<{ name: string; installed: boolean }> {
    return this.availableBundles.map(name => ({ name, installed: this.installedBundles.has(name) }))
  }

  getInstalled(): string[] {
    return [...this.installedBundles]
  }

  registerAvailable(name: string) {
    if (!this.availableBundles.includes(name)) {
      this.availableBundles.push(name)
    }
  }
}

export const bundleProvider: Plugin = (ctx: any) => {
  const service = new BundleService()

  const dispose = ctx.provide('bundle', {
    install: (name: string) => service.install(name),
    uninstall: (name: string) => service.uninstall(name),
    list: () => service.list(),
    getInstalled: () => service.getInstalled(),
    registerAvailable: (name: string) => service.registerAvailable(name),
  })

  return dispose
}
