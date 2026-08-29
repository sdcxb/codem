// @ts-nocheck
/**
 * @codem/ui-game — 大富翁小游戏 UI 插件
 *
 * 注册 GameView 组件到 app.game slot。
 * 默认关闭，需在插件管理中手动启用后才会显示游戏 Tab 入口。
 *
 * 关闭此 Provider 后，Slot 中的组件被移除，游戏 Tab 入口隐藏。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { lazy, Suspense, createElement } from 'react'

// 懒加载游戏组件
const GameViewLazy = lazy(() =>
  import('../../plugins/monopoly-game/components/GameView').then(m => ({ default: m.GameView }))
)

// 包装组件：提供 Suspense fallback
function GameViewWrapper() {
  return createElement(
    'div',
    { style: { width: "100%", height: "100%", overflow: "hidden", position: "relative" } },
    createElement(
      Suspense,
      { fallback: createElement('div', { style: { color: "#fff", textAlign: "center", marginTop: 200 } }, "加载游戏...") },
      createElement(GameViewLazy)
    )
  )
}

export const uiGameProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render() { return { type: 'game-view' } },
      startGame() { return { started: true } },
    }

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register(
      { name: 'app.game', id: 'r8-gameview', priority: 5 },
      GameViewWrapper
    )

    const disp = ctx.provide('uiGame', s)

    // Composite dispose: clean up both provide and slot registration
    return () => {
      if (disp) disp()
      if (unreg) unreg()
    }
  },
  { inject: ['slots'] }
)
