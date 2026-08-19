// @ts-nocheck
/**
 * @codem/host-plugin-inventory — 插件清单插件 (P2-7.13)
 *
 * 管理已安装插件的清单（名称、版本、描述、状态）。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链 → 插件管理面板）：
 * - 启动时：注册插件清单服务，UI 可通过它获取已安装插件列表
 * - 停止时：清单不可用，插件管理面板显示空
 */
import type { Plugin } from '../cordis/src/index.ts'

interface PluginEntry {
  name: string
  version: string
  description: string
  category: string
  status: 'active' | 'inactive' | 'error'
  unloadable: boolean
  requires: string[]
}

class HostPluginInventory {
  private inventory: Map<string, PluginEntry> = new Map()

  register(entry: PluginEntry) {
    this.inventory.set(entry.name, entry)
  }

  unregister(name: string) {
    this.inventory.delete(name)
  }

  get(name: string): PluginEntry | null {
    return this.inventory.get(name) || null
  }

  list(category?: string): PluginEntry[] {
    const all = Array.from(this.inventory.values())
    if (category) return all.filter(e => e.category === category)
    return all
  }

  listActive(): PluginEntry[] {
    return this.list().filter(e => e.status === 'active')
  }

  updateStatus(name: string, status: PluginEntry['status']) {
    const entry = this.inventory.get(name)
    if (entry) entry.status = status
  }

  exportManifest() {
    return {
      plugins: this.list(),
      count: this.inventory.size,
      activeCount: this.listActive().length,
    }
  }
}

export const hostPluginInventoryProvider: Plugin = (ctx: any) => {
  const inventory = new HostPluginInventory()

  const dispose = ctx.provide('hostPluginInventory', {
    register(entry: any) { inventory.register(entry) },
    unregister(name: string) { inventory.unregister(name) },
    get(name: string) { return inventory.get(name) },
    list(category?: string) { return inventory.list(category) },
    listActive() { return inventory.listActive() },
    updateStatus(name: string, status: any) { inventory.updateStatus(name, status) },
    exportManifest() { return inventory.exportManifest() },
  })

  return dispose
}
