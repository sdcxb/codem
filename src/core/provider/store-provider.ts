// @ts-nocheck
/**
 * Store Provider 插件 — 将 Zustand store 注册为 Cordis 服务。
 *
 * 这样插件可以通过 ctx.get('appStore') / ctx.get('projectStore')
 * 访问状态，而非直接 import。
 *
 * 注意：Zustand store 本身是全局单例，但通过 Provider 包装后，
 * 插件可以在运行时通过 ctx 获取，且未来可以替换为其他实现。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { useAppStore } from '../../store'
import { useProjectStore } from '../store'

export const storeProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('appStore', {
    getState: () => useAppStore.getState(),
    subscribe: (listener: any) => useAppStore.subscribe(listener),
    setState: (partial: any) => useAppStore.setState(partial),
  })

  const dispose2 = ctx.provide('projectStore', {
    getState: () => useProjectStore.getState(),
    subscribe: (listener: any) => useProjectStore.subscribe(listener),
    setState: (partial: any) => useProjectStore.setState(partial),
  })

  return () => { dispose(); dispose2() }
}

// P1-6.5建议4: Provider 依赖声明
;(storeProvider as any).requires = []
;(storeProvider as any).category = 'core'
;(storeProvider as any).unloadable = false
