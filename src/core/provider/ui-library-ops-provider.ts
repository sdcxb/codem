// @ts-nocheck
/**
 * @codem/ui-library-ops — 图书馆运营监控 UI 插件（接管两个宿主页签）
 *
 * v1.15.0 起本插件在「任务管理」里占两个页签，各自承担一类信息：
 * - `task-center.board`（看板）：`LibraryOpsBoardView` —— 看板（宿主 Issues）/ 用量 / 工具 / 错误 / 时间线
 * - `task-center.subagents`（子智能体）：`LibraryOpsSceneView` —— 场景 / 设置
 *
 * 为什么这样分：场景里站着的就是队长 / 团队成员 / 子智能体，是「子智能体在做什么」的
 * 可视化表达；而「设置」调的全是场景显示（场景图 / 名牌 / 气泡 / 动画速度 / 采样间隔）。
 * **本插件没有独立面板/页签**：两个页签都只是接管宿主已有的页签；插件禁用时两个 slot
 * 均无贡献者 → 看板回退到宿主 Issues 看板、子智能体回退到宿主列表，宿主 UI 回到原样。
 *
 * 快捷键 / 事件：
 * - `Ctrl/Cmd+Shift+L` 或 `codem:open-library-ops` → 打开「任务管理 → 子智能体 → 场景」
 *   （派发宿主已有的 `codem:open-task-center` 事件，不新增宿主耦合）。
 * - 设置里勾选「启动时自动打开」→ 启动后自动切到该页签。
 *
 * 启停语义：
 * - 插件管理里禁用 `@codem/ui-library-ops` → 本 provider 不装配 → 页签内容、
 *   快捷键、事件监听全部消失，宿主 UI/数据零变化（插件只读宿主数据）。
 * - 页签卸载（切走或关闭任务管理）即停止采样，不做任何后台轮询。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { lazy, Suspense, createElement } from 'react'

/** 任务管理「看板」页签的扩展 slot（与 TaskCenter.tsx 的 TASK_CENTER_BOARD_SLOT 一致） */
export const LIBRARY_TASK_SLOT = 'task-center.board'
/** 任务管理「子智能体」页签的扩展 slot（与 TaskCenter.tsx 的 TASK_CENTER_SUBAGENTS_SLOT 一致） */
export const LIBRARY_SUBAGENTS_SLOT = 'task-center.subagents'
/** 任务管理「概览」页签的扩展 slot（用量：KPI/健康度/活动分布/token 与成本） */
export const LIBRARY_OVERVIEW_SLOT = 'task-center.overview'

/** 打开场景视图（等价于打开任务管理并切到「子智能体 → 场景」页签） */
export function openLibraryView() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('codem:open-task-center', { detail: { tab: 'subagents', view: 'scene' } })
    )
  }
  return { opened: true }
}

const BoardLazy = lazy(() =>
  import('../../plugins/library-ops/components/LibraryOpsBoardView').then(m => ({ default: m.LibraryOpsBoardView }))
)

const SceneLazy = lazy(() =>
  import('../../plugins/library-ops/components/LibraryOpsSceneView').then(m => ({ default: m.LibraryOpsSceneView }))
)

const UsageLazy = lazy(() =>
  import('../../plugins/library-ops/components/LibraryOpsUsageEmbed').then(m => ({ default: m.LibraryOpsUsageEmbed }))
)

function BoardWrapper() {
  return createElement(Suspense, { fallback: null }, createElement(BoardLazy))
}

function SceneWrapper() {
  return createElement(Suspense, { fallback: null }, createElement(SceneLazy))
}

function UsageWrapper() {
  return createElement(Suspense, { fallback: null }, createElement(UsageLazy))
}

export const uiLibraryOpsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      /** 打开场景视图（任务管理 → 子智能体 → 场景） */
      open() {
        return openLibraryView()
      },
      /** 是否已装配 */
      get installed() {
        return true
      },
    }

    const slots = ctx.get('slots')
    const unregBoard = slots.register(
      { name: LIBRARY_TASK_SLOT, id: 'library-ops-board-view', priority: 20 },
      BoardWrapper
    )
    const unregScene = slots.register(
      { name: LIBRARY_SUBAGENTS_SLOT, id: 'library-ops-scene-view', priority: 20 },
      SceneWrapper
    )
    const unregUsage = slots.register(
      { name: LIBRARY_OVERVIEW_SLOT, id: 'library-ops-usage', priority: 20 },
      UsageWrapper
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

    // Composite dispose: 同时回收 provide / 三处 slot 注册 / 全局监听
    return () => {
      if (disp) disp()
      if (unregBoard) unregBoard()
      if (unregScene) unregScene()
      if (unregUsage) unregUsage()
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('codem:open-library-ops', onLegacy)
      }
      if (autoTimer) clearTimeout(autoTimer)
    }
  },
  { inject: ['slots'] }
)
