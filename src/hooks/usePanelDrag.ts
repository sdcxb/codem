/**
 * usePanelDrag — 浮层面板「按住标题栏拖动」的公共实现（P2-11）。
 *
 * ## 为什么抽出来
 *
 * 原先 `SideSessionPanel` 在 `pointerdown` 里直接把 `pointermove` / `pointerup`
 * 挂到 `window` 上，**唯一**的移除点在 `onUp` 里。于是只要手势不是以 `pointerup`
 * 结束（触摸/触控笔被系统手势接管 → `pointercancel`；拖动中窗口失焦/Alt+Tab
 * → `pointerup` 落到别的窗口；拖动中面板被卸载），监听器就永久留在 `window` 上，
 * 每次鼠标移动都会对已卸载的组件 setState，并把它所在的整块闭包钉在内存里。
 *
 * 这里改成「**由 state 驱动的 effect**」：监听器只在 `dragging === true` 时存在，
 * 而 effect 的清理函数天然覆盖「卸载」与「手势以任何方式结束」两种情况
 * （`useEffect` 的 cleanup 在组件卸载时一定执行）—— 卸载路径不再依赖
 * 「某个事件一定会到达」这个假设。
 *
 * 用法：
 * ```tsx
 * const { dragging, startDrag } = usePanelDrag();
 * <div onPointerDown={(e) => startDrag(e, getPanelRect())}>…</div>
 * ```
 *
 * @param onMove 每次指针移动时回调目标位置（已做非负钳制）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

interface DragOrigin {
  /** 面板左上角 x（px） */
  left: number;
  /** 面板左上角 y（px） */
  top: number;
}

export interface UsePanelDragResult {
  /** 是否正在拖动（可用于切换 cursor） */
  dragging: boolean;
  /**
   * 在标题栏的 `onPointerDown` 里调用。
   * @param e React 指针事件（需要 `clientX`/`clientY`）
   * @param origin 被拖面板当前的左上角坐标（`getBoundingClientRect()` 的 left/top）
   */
  startDrag: (e: React.PointerEvent | PointerEvent, origin: DragOrigin) => void;
}

export function usePanelDrag(
  onMove: (pos: { x: number; y: number }) => void,
): UsePanelDragResult {
  const [dragging, setDragging] = useState(false);
  const grabOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  /** 回调用 ref 持有，避免调用方每次渲染换函数导致拖动中途重新挂监听 */
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const startDrag = useCallback(
    (e: React.PointerEvent | PointerEvent, origin: DragOrigin) => {
      grabOffsetRef.current = { dx: e.clientX - origin.left, dy: e.clientY - origin.top };
      setDragging(true);
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (ev: PointerEvent) => {
      const grab = grabOffsetRef.current;
      if (!grab) return;
      onMoveRef.current({
        x: Math.max(0, ev.clientX - grab.dx),
        y: Math.max(0, ev.clientY - grab.dy),
      });
    };
    /** 幂等的结束函数：pointerup / pointercancel / 失焦 / 卸载都走这里 */
    const endDrag = () => {
      grabOffsetRef.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", endDrag);
    // 手势被系统接管（触摸/触控笔）时只发 pointercancel，不发 pointerup
    window.addEventListener("pointercancel", endDrag);
    // 拖动中窗口失焦（Alt+Tab / 点到别的窗口）时 pointerup 落在别处
    window.addEventListener("blur", endDrag);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
      // 卸载 / 依赖变化时不留半开的拖拽状态
      grabOffsetRef.current = null;
    };
  }, [dragging]);

  return { dragging, startDrag };
}

export default usePanelDrag;
