// @ts-nocheck
/**
 * @codem/typert-registry — 类型注册表插件 (P2-7.15)
 *
 * 管理所有类型定义的注册表，提供查询和搜索。
 *
 * 功能链路融入：
 * - 启动时：注册类型注册表，其他服务可通过它查询类型
 * - 停止时：注册表不可用，类型查询返回空
 */
import type { Plugin } from '../cordis/src/index.ts'

interface TypeEntry {
  name: string
  kind: 'interface' | 'type' | 'enum' | 'class'
  definition: string
  source?: string
  description?: string
}

class TypertRegistry {
  private types: Map<string, TypeEntry> = new Map()

  register(entry: TypeEntry) {
    this.types.set(entry.name, entry)
  }

  unregister(name: string) {
    this.types.delete(name)
  }

  get(name: string): TypeEntry | null {
    return this.types.get(name) || null
  }

  search(query: string): TypeEntry[] {
    const lower = query.toLowerCase()
    return Array.from(this.types.values()).filter(t =>
      t.name.toLowerCase().includes(lower) ||
      (t.description?.toLowerCase().includes(lower) ?? false)
    )
  }

  list(kind?: TypeEntry['kind']): TypeEntry[] {
    const all = Array.from(this.types.values())
    if (kind) return all.filter(t => t.kind === kind)
    return all
  }

  clear() {
    this.types.clear()
  }
}

export const typertRegistryProvider: Plugin = (ctx: any) => {
  const registry = new TypertRegistry()

  const dispose = ctx.provide('typertRegistry', {
    register(entry: any) { registry.register(entry) },
    unregister(name: string) { registry.unregister(name) },
    get(name: string) { return registry.get(name) },
    search(query: string) { return registry.search(query) },
    list(kind?: any) { return registry.list(kind) },
    clear() { registry.clear() },
  })

  return dispose
}
