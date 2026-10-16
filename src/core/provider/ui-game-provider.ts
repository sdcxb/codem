// @ts-nocheck
/**
 * `@codem/ui-game` —— 「游戏 Tab」的**开关插件**（不是 UI 实现）。
 *
 * ## 这个插件到底管什么（2026-10-16 定性，别被旧注释骗）
 *
 * 旧实现声称「注册 GameView 组件到 `app.game` slot」，但两件事都对不上：
 * 1. **那个槽位从来没被声明过** —— `SlotsService.register()` 对未声明的槽位直接抛错
 *    （`slots/index.ts:171`：`slot "…" is not declared`），所以这个 provider 一旦真被装配，
 *    它的 fiber 就会 FAILED（启动汇总会如实报"未激活"）；
 * 2. **游戏界面根本不走槽位** —— `src/App.tsx` 三处直接
 *    `lazy(() => import("./plugins/monopoly-game/components/GameView"))` 渲染，
 *    是否显示由 `isPluginDisabled('@codem/ui-game')` 决定（读 `codem-disabled-plugins`）。
 *
 * 也就是说：**这个插件的真实职责是"让插件管理器里有一个可启停的条目"**，
 * 而它的"生效 / 失效"由 App 直接读那份禁用列表完成。
 *
 * ## 所以现在的形状
 *
 * `apply` **故意什么也不做**（空操作）：插件在 `config/codem.base.yml` 里被装配、
 * 在插件管理器里可启停 —— 启用 = 把 `@codem/ui-game` 从 `codem-disabled-plugins` 移除
 * （App 立刻显示游戏 Tab），停用 = 反向。它**不提供任何服务、不注册任何槽位**：
 * 那些都曾经是假的（假服务 + 未声明的槽位）。
 *
 * 判据：`src/test/plugin-assembly-path.test.ts`（SO-8：注册表里每个插件都必须有真实装配路径）
 * 与 `src/test/ui-game-switch.test.ts`（本插件必须是空操作：不许 provide、不许注册槽位）。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiGameProvider: Plugin = () => {
  // 空操作 —— 真正的"开关"是 App 读的 codem-disabled-plugins（见文件头说明）。
  // 刻意不 ctx.provide、不 slots.register：任何"看起来有功能"的注册都是假的（并且那个槽位没声明，register 会抛）。
  return () => {}
}
