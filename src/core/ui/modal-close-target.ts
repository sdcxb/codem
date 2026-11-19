/**
 * 「关掉最上层弹窗」的目标查找（Batch 6C 无障碍）。
 *
 * ## 现场
 *
 * 审计脚本在关闭 App 级 `.modal-overlay` 时发现：**按 Esc 没有任何反应**。
 * 这批弹窗（MCP / 技能 / 记忆 / 插件 / 笔记本 / 智能体 / 任务中心 / 项目 …）是早期手写结构，
 * 只支持「点遮罩」与「点关闭按钮」两条路，而遮罩本身不可聚焦 ⇒ 键盘用户被卡在弹窗里。
 *
 * ## 为什么这里只有"找按钮"，没有键盘监听
 *
 * 仓里对浮层有一道硬门禁（`dismissable-layer.test.tsx` 的 OVERLAY-1）：**Keyboard 事件只许
 * `useDismissableLayer` 一处监听**，别处再手写 `window.addEventListener("keydown")` 会判红。
 * 所以本模块只提供**纯函数**（找最上层弹窗里的显式关闭按钮并点它），
 * 键盘那一路由 `App.tsx` 里的 `useDismissableLayer({ onDismiss: closeTopmostModal })` 统一驱动。
 *
 * ## 为什么是"点关闭按钮"而不是"点遮罩"
 *
 * 点遮罩等价于 `onClick={onClose}`，但有的弹窗遮罩点击**不关闭**（权限确认、计划批准等需要
 * 用户明确选择的），对它们合成一次遮罩点击可能被解读成「取消 / 拒绝」。
 * 所以只认**显式的关闭入口**，找不到就什么都不做（宁可不开这一路，也不能替用户做决定）。
 */

const OVERLAY_SELECTORS = [
  ".modal-overlay",
  ".settings-overlay",
  ".confirm-overlay",
  ".nb-dialog-overlay",
  ".nb-editor-overlay",
  ".nb-workspace-overlay",
  ".nb-source-viewer-overlay",
  ".diff-viewer-overlay",
  ".pipeline-dialog-overlay",
  ".needs-you-overlay",
  ".permission-overlay",
  ".drawer-overlay",
  ".image-gallery-overlay",
];

const CLOSE_SELECTORS = [
  '[aria-label^="关闭"]',
  ".modal-close",
  ".modal-editor-close",
  ".settings-close",
  ".memory-manager-close",
  ".panel-sidebar-close",
  ".right-sidebar-close",
  ".file-editor-close",
  ".search-close",
  ".diff-close-btn",
];

/**
 * 「可见」只看计算样式，不看尺寸。
 *
 * 为什么不看 rect：jsdom 没有布局，所有元素的 getBoundingClientRect 都是 0×0，
 * 加上尺寸判断会让判据在单测里恒为「不可见」（实测 3 条用例假红）。
 * 真实浏览器里隐藏的浮层几乎都是 display:none / visibility:hidden / opacity:0。
 */
function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return Number(style.opacity || "1") > 0.05;
}

/** 找到最上层可见弹窗里的显式关闭按钮；没有则 null */
export function findTopmostModalCloseButton(doc: Document = document): HTMLElement | null {
  const overlays = Array.from(doc.querySelectorAll(OVERLAY_SELECTORS.join(","))).filter(isVisible);
  if (overlays.length === 0) return null;
  const top = overlays[overlays.length - 1];
  for (const selector of CLOSE_SELECTORS) {
    const btn = Array.from(top.querySelectorAll<HTMLElement>(selector)).find(isVisible);
    if (btn) return btn;
  }
  return null;
}

/** 点掉最上层弹窗的关闭按钮；返回是否点到了 */
export function closeTopmostModal(doc: Document = document): boolean {
  const btn = findTopmostModalCloseButton(doc);
  if (!btn) return false;
  btn.click();
  return true;
}
