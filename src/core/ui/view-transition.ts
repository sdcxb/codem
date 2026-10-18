/**
 * 共享元素转场（View Transitions API）的**安全封装**。
 *
 * ## 为什么需要
 *
 * 对标 open-claude-ui 的 `useClaudeSharedElementTransition`：图片从缩略图"长成"大图，
 * 而不是突然弹出一个模态。浏览器原生 `document.startViewTransition` 做这件事最省事，
 * 但它有两个必须处理的现实：
 *
 * 1. **不是所有运行时都支持**（WebView2 旧版、测试环境、部分 Linux）；
 * 2. 它**异步**捕获快照 —— 更新函数里必须是同步提交（React 用 `flushSync`）。
 *
 * 这里只提供"有就用、没有就跑普通更新、抛错也绝不吞掉更新"的最小封装；
 * 元素上的 `view-transition-name` 由调用方设置（命名唯一性由调用方保证）。
 *
 * 判据 `VIEWTRANS-1..3`。
 */

type ViewTransitionCapable = {
  startViewTransition?: (update: () => void) => unknown;
};

/** 当前文档是否支持 View Transitions */
export function supportsViewTransitions(doc: Document | undefined = globalThis.document): boolean {
  const d = doc as unknown as ViewTransitionCapable | undefined;
  return typeof d?.startViewTransition === "function";
}

/**
 * 在转场里执行 `update`；不支持或抛错时**仍然执行 update**（降级为普通切换）。
 *
 * 返回值仅用于测试/日志观察（真实调用方不需要它）。
 */
export function runViewTransition(
  update: () => void,
  doc: Document | undefined = globalThis.document,
): { usedViewTransition: boolean } {
  const d = doc as unknown as ViewTransitionCapable | undefined;
  if (typeof d?.startViewTransition === "function") {
    try {
      d.startViewTransition(update);
      return { usedViewTransition: true };
    } catch {
      // 抛错也要把界面切过去 —— 不能让"动画失败"表现成"点了没反应"
    }
  }
  update();
  return { usedViewTransition: false };
}
