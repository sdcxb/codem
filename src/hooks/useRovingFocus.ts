/**
 * 通用 roving focus 钩子（DOM 接线部分；键位语义在 `core/ui/roving-focus.ts`）。
 *
 * 用法：
 * ```tsx
 * const roving = useRovingFocus<HTMLDivElement>({ orientation: "vertical" });
 * <div ref={roving.containerRef} onKeyDown={roving.onKeyDown}> <button/>… </div>
 * ```
 *
 * 语义（与 WAI-ARIA roving tabindex 对齐）：
 * - 方向键在**当前容器内的可聚焦项**之间移动，两端回绕；
 * - Home / End 到首尾，PageUp / PageDown 跳 5 项；
 * - **Tab 不拦截**（必须能正常离开这组控件）；
 * - 不处理 RTL 判定之外的任何布局测量（避免依赖真实布局，便于测试）。
 */
import { useCallback, useRef } from "react";
import { nextRovingIndex, type RovingOrientation } from "../core/ui/roving-focus";

export interface UseRovingFocusOptions {
  orientation?: RovingOrientation;
  /** 由调用方决定（组件可读 getLang 或 dir 属性）；缺省按 LTR */
  rtl?: boolean;
  /** 项选择器；缺省取容器内所有非 disabled 的 button / [data-roving-item] */
  itemSelector?: string;
}

export interface RovingFocusBinding<T extends HTMLElement> {
  containerRef: React.RefObject<T>;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useRovingFocus<T extends HTMLElement>(
  options: UseRovingFocusOptions = {},
): RovingFocusBinding<T> {
  const { orientation = "vertical", rtl = false, itemSelector = "button:not([disabled]), [data-roving-item]:not([disabled])" } =
    options;
  const containerRef = useRef<T>(null);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector)).filter(
        (el) => el.offsetParent !== null || el.getClientRects().length > 0,
      );
      if (items.length === 0) return;
      const current = items.findIndex((el) => el === document.activeElement);
      const next = nextRovingIndex(current, items.length, e.key, orientation, rtl);
      if (next === null) return; // Tab / 其它键：不拦截
      e.preventDefault();
      items[next]?.focus({ preventScroll: true });
    },
    [itemSelector, orientation, rtl],
  );

  return { containerRef, onKeyDown };
}
