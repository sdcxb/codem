// @ts-nocheck
/**
 * @codem/scope — 多 Scope 上下文隔离，不同 Agent/会话的上下文隔离管理。
 *
 * 参考自 DSH (DeepSeek Harness) packages/core/scope/src/index.ts:
 *   - ScopedLayers 实现全局 + 分 scope 的层叠注册
 *   - scope chain: 全局 → 父 scope → 子 scope（近处覆盖远处）
 *   - merge(scope, selector) 合并全局和 scope 链上的条目
 *
 * 本 Provider 实现了 DSH 的核心模式：
 * 1. create(id, parent?) — 创建子 scope
 * 2. set(k, v, scope?) — 在指定 scope 或活跃 scope 写入
 * 3. get(k, scope?) — 从 scope 链读取（近处优先）
 * 4. merge(scope, selector) — 合并全局和 scope 链的条目
 */
import type { Plugin } from '../cordis/src/index.ts'

/** 一个 Scope 层 */
interface ScopeLayer {
  id: string
  parent: string | null
  data: Map<string, any>
}

export const scopeProvider: Plugin = (ctx: any) => {
  /** 全局 scope */
  const globalLayer: ScopeLayer = { id: 'global', parent: null, data: new Map() }
  /** 所有 scope 层（含全局） */
  const layers = new Map<string, ScopeLayer>([['global', globalLayer]])
  /** 活跃 scope id */
  let activeId = 'global'

  /** 获取 scope 链（从近到远） */
  const chainOf = (scopeId: string): ScopeLayer[] => {
    const chain: ScopeLayer[] = []
    let current = layers.get(scopeId)
    let depth = 0
    while (current && depth < 100) { // 防止循环
      chain.push(current)
      if (current.parent === null) break
      current = layers.get(current.parent)
      depth++
    }
    return chain
  }

  /** 合并全局和 scope 链的条目 — 参考 DSH ScopedLayers.merge() */
  const merge = <T>(scopeId: string | undefined, selector: (layer: ScopeLayer) => Iterable<[string, T]>): Map<string, T> => {
    const result = new Map<string, T>()
    // 全局先入
    for (const [k, v] of selector(globalLayer)) result.set(k, v)
    // scope 链从远到近，近处覆盖远处
    if (scopeId && scopeId !== 'global') {
      const chain = chainOf(scopeId).reverse() // 远→近
      for (const layer of chain) {
        if (layer.id === 'global') continue
        for (const [k, v] of selector(layer)) result.set(k, v)
      }
    }
    return result
  }

  const service = {
    /**
     * 创建子 scope — 参考 DSH ScopedLayers
     */
    create(id: string, parent: string | null = null): ScopeLayer {
      const layer: ScopeLayer = { id, parent: parent ?? activeId, data: new Map() }
      layers.set(id, layer)
      return layer
    },

    /** 获取 scope 层 — 重命名以避免与下面的 get(k, scopeId) 冲突 */
    getScope(id: string): ScopeLayer | undefined {
      return layers.get(id)
    },

    /** 设置活跃 scope */
    setActive(id: string) {
      if (!layers.has(id)) this.create(id)
      activeId = id
    },

    /** 获取活跃 scope id */
    getActive(): string {
      return activeId
    },

    /**
     * 在指定 scope 或活跃 scope 写入 — 参考 DSH ScopeLayer.data.set()
     */
    set(k: string, v: any, scopeId?: string) {
      const layer = layers.get(scopeId || activeId) || globalLayer
      layer.data.set(k, v)
    },

    /**
     * 从 scope 链读取（近处优先）— 参考 DSH ScopedLayers.chain()
     */
    get(k: string, scopeId?: string): any {
      const chain = chainOf(scopeId || activeId)
      for (const layer of chain) {
        if (layer.data.has(k)) return layer.data.get(k)
      }
      // 也检查全局（如果 scopeId 指定了非全局）
      if (scopeId && scopeId !== 'global' && globalLayer.data.has(k)) {
        return globalLayer.data.get(k)
      }
      return undefined
    },

    /** 删除 scope */
    remove(id: string) {
      layers.delete(id)
      if (activeId === id) activeId = 'global'
    },

    /** 获取所有 scope id */
    list(): string[] {
      return [...layers.keys()]
    },

    /** 合并条目 — 参考 DSH ScopedLayers.merge() */
    merge<T>(scopeId: string | undefined, selector: (layer: ScopeLayer) => Iterable<[string, T]>): Map<string, T> {
      return merge(scopeId, selector)
    },

    /** 获取 scope 链 */
    chain(scopeId: string): ScopeLayer[] {
      return chainOf(scopeId)
    },

    /** 获取全局 scope */
    get global(): ScopeLayer {
      return globalLayer
    },
  }

  return ctx.provide('scope', service)
}
