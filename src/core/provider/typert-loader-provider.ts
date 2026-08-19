// @ts-nocheck
/**
 * @codem/typert-loader — 类型加载器插件 (P2-7.15)
 *
 * 加载外部类型定义文件（.d.ts），供类型检查使用。
 *
 * 功能链路融入：
 * - 启动时：注册类型加载器，加载项目中的类型定义
 * - 停止时：类型不加载，类型检查不可用
 */
import type { Plugin } from '../cordis/src/index.ts'

class TypertLoader {
  private loadedTypes: Map<string, { source: string; content: string }> = new Map()

  async loadFromSource(name: string, content: string): Promise<void> {
    this.loadedTypes.set(name, { source: 'inline', content })
  }

  async loadFromFile(name: string, filePath: string): Promise<void> {
    try {
      const { readFileSync } = await import('fs')
      const content = readFileSync(filePath, 'utf-8')
      this.loadedTypes.set(name, { source: filePath, content })
    } catch (err) {
      console.error(`[TypertLoader] Failed to load ${filePath}:`, err)
    }
  }

  get(name: string): { source: string; content: string } | null {
    return this.loadedTypes.get(name) || null
  }

  list(): string[] {
    return Array.from(this.loadedTypes.keys())
  }

  unload(name: string) {
    this.loadedTypes.delete(name)
  }

  clear() {
    this.loadedTypes.clear()
  }
}

export const typertLoaderProvider: Plugin = (ctx: any) => {
  const loader = new TypertLoader()

  const dispose = ctx.provide('typertLoader', {
    async loadFromSource(name: string, content: string) { return loader.loadFromSource(name, content) },
    async loadFromFile(name: string, filePath: string) { return loader.loadFromFile(name, filePath) },
    get(name: string) { return loader.get(name) },
    list() { return loader.list() },
    unload(name: string) { loader.unload(name) },
    clear() { loader.clear() },
  })

  return dispose
}
