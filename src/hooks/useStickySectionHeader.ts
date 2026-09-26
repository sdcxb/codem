/**
 * 侧栏分组标题的「吸顶」判定（第 166 轮 P1-3）。
 *
 * 用法：`const stickyRef = useStickySectionHeader<HTMLDivElement>();` ⇒ `<div className="sidebar-section-header" ref={stickyRef}>`。
 * 滚到顶部（被内容盖过）时它会自己加上 `is-stuck` 类 —— CSS 只在那个类上画分隔线，
 * 静止时不留痕（对方 `StickySectionHeader` 的 `is-stuck` 同构）。
 *
 * 为什么用 IntersectionObserver 而不是 scroll 监听：滚动时逐帧读布局会掉帧，
 * 而这里只需要知道「标题有没有贴到容器顶」这一件事。
 * 哨兵是插在标题**前面**的 1px 元素：它一旦离开可视区，就说明标题已经吸住了。
 *
 * ⚠️ 返回的是**回调 ref**，不是 `RefObject`：本仓库的 React 类型里 `RefObject<T>` 的 `current` 是**非空**的
 * （React 19 口径），而 `useRef<T | null>(null)` 推出来的是 `RefObject<T | null>`，直接挂 `ref` 会报
 * 「`HTMLDivElement | null` 不能赋给 `HTMLDivElement`」（实测踩过一次）。回调 ref 两边都收，最省事。
 */
import { useCallback, useRef } from "react";

export function useStickySectionHeader<T extends HTMLElement>(): (el: T | null) => void {
  const teardown = useRef<(() => void) | null>(null);

  return useCallback((el: T | null) => {
    teardown.current?.();
    teardown.current = null;
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    /* 哨兵不能撑开布局：绝对定位 + 1px；`position:absolute` 需要父级有定位上下文，
       没有也不影响判定（它会被放在父级内容流起点）。 */
    sentinel.style.cssText = "position:absolute;top:0;height:1px;width:1px;pointer-events:none;";
    parent.insertBefore(sentinel, el);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          /* 哨兵不可见（被滚过去了）⇒ 标题正在吸顶 */
          el.classList.toggle("is-stuck", !entry.isIntersecting);
        }
      },
      { root: el.closest(".sidebar-sessions") ?? null, threshold: 0 },
    );
    observer.observe(sentinel);

    teardown.current = () => {
      observer.disconnect();
      sentinel.remove();
      el.classList.remove("is-stuck");
    };
  }, []);
}
