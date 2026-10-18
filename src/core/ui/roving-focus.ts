/**
 * roving focus 的**纯逻辑**：按键 → 下一个焦点下标。
 *
 * ## 为什么需要统一实现（对标 open-claude-ui 的 useClaudeRovingFocus）
 *
 * 我们此前的方向键逻辑散在 6 个组件里（菜单 / 提及候选 / 输入框…），行为并不一致：
 * 有的到底不回绕、有的不认 Home/End、RTL 镜像根本没处理、Tab 逃逸时还会 preventDefault。
 * 而 WAI-ARIA 的 roving tabindex 模式是**一组固定语义**：方向键在一组项内移动、
 * Home/End 跳首尾、Tab 正常离开、RTL 下左右镜像。
 *
 * 这里只抽"键 → 下标"的纯函数，DOM 侧的聚焦由 `hooks/useRovingFocus.ts` 负责；
 * 判据 `ROVING-1..5`。
 */

export type RovingOrientation = "vertical" | "horizontal" | "both";

export type RovingKey =
  | "ArrowDown"
  | "ArrowUp"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

const KEYS: RovingKey[] = [
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

export function isRovingKey(key: string): key is RovingKey {
  return (KEYS as string[]).includes(key);
}

/** 一页跳过的项数（与浏览器文本滚动的手感对齐，不按可视高度算） */
export const ROVING_PAGE_SIZE = 5;

/**
 * 计算下一个焦点下标；返回 `null` 表示"这个键不归我管"（调用方不要 preventDefault）。
 *
 * - `current` 必须在 `[0, count)` 内，否则按 0 处理；
 * - 方向键在两端**回绕**（WAI-ARIA 常见做法；与"到底停住"相比，回绕不会让键盘用户卡住）；
 * - RTL 只在水平轴上镜像（垂直轴与书写方向无关）；
 * - Home/End 到首尾；PageUp/PageDown 按 `ROVING_PAGE_SIZE` 跳，越界夹紧。
 */
export function nextRovingIndex(
  current: number,
  count: number,
  key: string,
  orientation: RovingOrientation = "vertical",
  rtl = false,
): number | null {
  if (!isRovingKey(key) || count <= 0) return null;
  const start = current >= 0 && current < count ? current : 0;
  const vertical = orientation === "vertical" || orientation === "both";
  const horizontal = orientation === "horizontal" || orientation === "both";

  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "PageUp") return Math.max(0, start - ROVING_PAGE_SIZE);
  if (key === "PageDown") return Math.min(count - 1, start + ROVING_PAGE_SIZE);

  let delta = 0;
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!vertical) return null;
    delta = key === "ArrowDown" ? 1 : -1;
  } else if (key === "ArrowLeft" || key === "ArrowRight") {
    if (!horizontal) return null;
    const forward = key === "ArrowRight";
    // RTL：右箭头往"前一个"，左箭头往"后一个"
    delta = (forward ? 1 : -1) * (rtl ? -1 : 1);
  }
  return (start + delta + count) % count;
}
