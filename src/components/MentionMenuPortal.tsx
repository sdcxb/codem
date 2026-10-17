/**
 * MentionMenuPortal — `@` 提及候选的 Portal 宿主（第 232 波）。
 *
 * ## 为什么要有这个组件
 *
 * 缺陷（真机取证）：`MentionAutocomplete` 原来就地渲染在 `.input-textarea-row` 里，而它的祖辈
 * `.input-area.input-card-container` 有 `overflow: hidden; height: 135px`（高度是**有意固定**的）。
 * 候选面板 240px 高、锚点在输入行上方 ⇒ 被裁到**只剩 9px**（`clippedByPx: 231`），
 * `elementFromPoint` 在候选位置命中的是 `.messages-container` —— 用户既看不见也点不到。
 * 同一块输入区里的 `/` 菜单早就用 Portal 绕开了同一个问题（`InputArea.tsx` 里那条注释
 * 「避免被 overflow:hidden 裁剪」），所以这里的修法是**与 `/` 对齐**，而不是去动输入区的高度/溢出
 * （那会牵动整个 Composer 的布局）。
 *
 * ## 契约
 *
 * - 只负责「挂到 body + 按锚点定位」，候选列表本身的渲染/键盘仍在 `MentionAutocomplete` 里；
 * - 位置由调用方算（`left` / `bottom` / `width`，`bottom` 是距视口底部的像素，与 `/` 菜单同口径），
 *   滚动/resize 时由调用方重算后重新传入 —— 本组件不自己订阅，避免两处各算一份；
 * - 用共享入口 `./ui/portal`（PORTAL-1 要求生产代码只从这里取 `createPortal`），
 *   非浏览器环境安全返回 `null`。
 */
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "./ui/portal";

export interface MentionMenuPos {
  /** 视口坐标：左边界（px） */
  left: number;
  /** 距视口底部的距离（px）；候选贴在锚点上方，所以用 bottom 而不是 top */
  bottom: number;
  /** 宽度（px）；跟随输入行宽度 */
  width: number;
}

/**
 * 把候选面板挂到 `document.body` 下（`position: fixed`），使其脱离输入卡的裁剪链。
 *
 * z-index 取 `--z-top`（与 `/` 菜单同一档）：输入区自身是 `z-index: 50` 的层叠上下文，
 * 候选必须站在它之上，否则会被同一个输入区/消息区盖住。
 */
export function MentionMenuPortal({ pos, children }: { pos: MentionMenuPos; children: ReactNode }) {
  const style: CSSProperties = {
    left: pos.left,
    bottom: pos.bottom,
    width: pos.width,
    zIndex: "var(--z-top)",
  };
  return createPortal(
    <div className="mention-menu-portal" style={style}>
      {children}
    </div>,
  );
}
