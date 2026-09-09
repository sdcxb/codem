// @ts-nocheck
/**
 * @codem/ui-library-ops — 图书馆运营监控 UI 插件
 *
 * 注册 `LibraryOpsLauncher` 到 `app.overlay`（App.tsx 已消费的全局 list 型
 * 叠加层）。组件自身负责：悬浮入口胶囊 + 全屏监控面板（Portal 到 body）。
 *
 * 启停语义：
 * - 插件管理里禁用 `@codem/ui-library-ops` → 本 provider 不装配 → 入口与面板
 *   完全不存在，宿主 UI/数据零变化（本插件只读宿主数据，从不写入）。
 * - 面板关闭时停止采样，不做任何后台轮询。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { lazy, Suspense, createElement } from 'react'

const LauncherLazy = lazy(() =>
  import('../../plugins/library-ops/components/LibraryOpsLauncher').then(m => ({ default: m.LibraryOpsLauncher }))
)

function LauncherWrapper() {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(LauncherLazy)
  )
}

export const uiLibraryOpsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      /** 打开监控面板 */
      open() {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('codem:open-library-ops'))
        }
        return { opened: true }
      },
      /** 是否已装配 */
      get installed() {
        return true
      },
    }

    const slots = ctx.get('slots')
    const unreg = slots.register(
      { name: 'app.overlay', id: 'library-ops-launcher', priority: 20 },
      LauncherWrapper
    )

    const disp = ctx.provide('uiLibraryOps', s)

    // Composite dispose: 同时回收 provide 与 slot 注册
    return () => {
      if (disp) disp()
      if (unreg) unreg()
    }
  },
  { inject: ['slots'] }
)
