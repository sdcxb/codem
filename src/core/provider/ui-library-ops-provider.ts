// @ts-nocheck
/**
 * @codem/ui-library-ops — 图书馆运营监控 UI 插件（接管「看板」页签）
 *
 * 注册 `LibraryOpsBoardView` 到 `task-center.board`（宿主「任务管理 → 看板」页签）。
 * **本插件没有独立面板/页签**：接管看板页签，在 Issues 看板之上追加
 * 场景 / 用量 / 工具 / 错误 / 时间线 / 设置 视图；插件禁用时该 slot 无贡献者
 * → 看板回退到宿主自带 Issues 看板，宿主 UI 回到原样。
 *
 * 快捷键 / 事件：
 * - `Ctrl/Cmd+Shift+L` 或 `codem:open-library-ops` → 打开「任务管理 → 看板」
 *   （派发宿主已有的 `codem:open-task-center` 事件，不新增宿主耦合）。
 * - 设置里勾选「启动时自动打开」→ 启动后自动切到该页签。
 *
 * 启停语义：
 * - 插件管理里禁用 `@codem/ui-library-ops` → 本 provider 不装配 → 页签、
 *   快捷键、事件监听全部消失，宿主 UI/数据零变化（插件只读宿主数据）。
 * - 页签卸载（切走或关闭任务管理）即停止采样，不做任何后台轮询。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { lazy, Suspense, createElement } from 'react'

/** 任务管理「看板」页签的扩展 slot（与 TaskCenter.tsx 的 TASK_CENTER_BOARD_SLOT 一致） */
export const LIBRARY_TASK_SLOT = 'task-center.board'

/** 打开看板视图（等价于打开任务管理并切到「看板」页签） */
export function openLibraryView() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('codem:open-task-center', { detail: { tab: 'board' } }))
  }
  return { opened: true }
}

const ViewLazy = lazy(() =>
  import('../../plugins/library-ops/components/LibraryOpsBoardView').then(m => ({ default: m.LibraryOpsBoardView }))
)

function ViewWrapper() {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(ViewLazy)
  )
}

export const uiLibraryOpsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      /** 打开看板视图（任务管理 → 看板页签） */
      open() {
        return openLibraryView()
      },
      /** 是否已装配 */
      get installed() {
        return true
      },
    }

    const slots = ctx.get('slots')
    const unreg = slots.register(
      { name: LIBRARY_TASK_SLOT, id: 'library-ops-board-view', priority: 20 },
      ViewWrapper
    )

    const disp = ctx.provide('uiLibraryOps', s)

    // 快捷键 + 事件别名（旧代码里的 codem:open-library-ops 继续可用）
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault()
        openLibraryView()
      }
    }
    const onLegacy = () => openLibraryView()
    let autoTimer = null
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKey)
      window.addEventListener('codem:open-library-ops', onLegacy)
      // 启动时自动打开（设置项，默认关闭）；延迟到宿主 UI 就绪后再派发
      import('../../plugins/library-ops/store')
        .then(m => {
          if (m.useLibraryOps.getState().settings.autoOpen) {
            autoTimer = setTimeout(() => openLibraryView(), 1200)
          }
        })
        .catch(() => { /* 插件未就绪时忽略 */ })
    }

    // Composite dispose: 同时回收 provide / slot 注册 / 全局监听
    return () => {
      if (disp) disp()
      if (unreg) unreg()
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('codem:open-library-ops', onLegacy)
      }
      if (autoTimer) clearTimeout(autoTimer)
    }
  },
  { inject: ['slots'] }
)
