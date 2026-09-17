/**
 * usePaneResize — 面板拖拽调整 Hook
 *
 * 支持侧边栏、右侧栏可拖拽调整宽度。
 * 使用 requestAnimationFrame 调度，避免拖拽卡顿。
 */

import { useState, useRef, useCallback, useEffect } from "react";

interface PaneResizeConfig {
  /** 最小宽度 */
  min: number;
  /** 最大宽度 */
  max: number;
  /** 初始宽度 */
  initial: number;
  /** 持久化 key（可选） */
  storageKey?: string;
}

export function usePaneResize(config: PaneResizeConfig) {
  const [width, setWidth] = useState(() => {
    if (config.storageKey) {
      try {
        const saved = localStorage.getItem(config.storageKey);
        if (saved) {
          const num = parseInt(saved, 10);
          if (!isNaN(num) && num >= config.min && num <= config.max) {
            return num;
          }
        }
      } catch {}
    }
    return config.initial;
  });

  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef({ x: 0, width: 0 });
  const frameRef = useRef<number | null>(null);
  /** 手势是否仍在进行（endResize 幂等的依据） */
  const activeRef = useRef(false);
  /** 最近一次**已经写进 state** 的宽度 */
  const widthRef = useRef(width);
  /** 最近一次**期望**的宽度（含还在 rAF 队列里、尚未落进 state 的那一次） */
  const pendingWidthRef = useRef(width);
  /** 结束手势要摘掉的监听器（全部注册在 document / window 上） */
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  /**
   * 结束拖拽 —— **幂等**，并且是唯一的释放路径。
   *
   * P1-10：原来只有 `pointerup` 会摘掉 `body.resizing-columns`，而
   * `src/styles/codem-ui.css` 里那条规则是 `body.resizing-columns * { pointer-events: none !important }`
   * —— 手势一旦以 `pointercancel`（系统抢走指针 / 触摸被取消）、窗口失焦、
   * 或者 `pointerup` 落在别的元素上结束，class 就永远摘不掉，**整个界面再也点不动**。
   * 所以 pointerup / pointercancel / window.blur / 组件卸载都收敛到这里。
   */
  const endResize = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setIsResizing(false);

    /**
     * 结算最后一次位移再退场。
     *
     * 两条结束路径的"最后位置"来源不同，必须都照顾到：
     * - pointerup 有事件坐标 → `handleUp` 已经把它写进 pendingWidthRef；
     * - pointercancel / 失焦 / 卸载没有坐标可用 → 只能靠 pointermove 期间记下的
     *   pendingWidthRef（可能还在 rAF 队列里，尚未落进 state）。
     * 所以这里只要 pending != 已提交值就补一次；pending 相等时是无操作。
     * 注意 activeRef 已经置 false，这不会反过来再触发一次 endResize。
     */
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (pendingWidthRef.current !== widthRef.current) {
      widthRef.current = pendingWidthRef.current;
      setWidth(pendingWidthRef.current);
    }

    // 摘监听器 + 摘 body class：**任何**结束路径都必须走到
    detachRef.current?.();
    detachRef.current = null;
    document.body.classList.remove("resizing-columns");

    if (config.storageKey) {
      try {
        localStorage.setItem(config.storageKey, String(widthRef.current));
      } catch {}
    }
  }, [config.storageKey]);

  /** 由指针坐标算出夹紧后的宽度 */
  const widthForX = useCallback((clientX: number) => {
    const delta = startRef.current.x - clientX;
    return Math.max(config.min, Math.min(config.max, startRef.current.width + delta));
  }, [config.min, config.max]);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 上一次手势若没被正确释放，先收干净（否则监听器会重复注册）
    endResize();

    activeRef.current = true;
    setIsResizing(true);
    startRef.current = { x: e.clientX, width };
    pendingWidthRef.current = width;

    const handleMove = (ev: PointerEvent) => {
      const next = widthForX(ev.clientX);
      pendingWidthRef.current = next;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        // Resize handle is on the LEFT edge of the right sidebar:
        // drag LEFT (negative delta) → wider, drag RIGHT (positive delta) → narrower
        const w = pendingWidthRef.current;
        widthRef.current = w;
        setWidth(w);
      });
    };

    /**
     * pointerup：先按事件坐标结算最终宽度（用户拖完直接松手时，
     * 最后一次 pointermove 可能还在 rAF 队列里），再走统一的 endResize。
     */
    const handleUp = (ev: PointerEvent) => {
      if (!activeRef.current) return;
      pendingWidthRef.current = widthForX(ev.clientX);
      endResize();
    };

    document.body.classList.add("resizing-columns");
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", endResize);
    window.addEventListener("blur", endResize);

    detachRef.current = () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", endResize);
      window.removeEventListener("blur", endResize);
    };
  }, [width, widthForX, endResize]);

  /**
   * 卸载路径通过 ref 取**最新**的 endResize。
   *
   * 为什么不把 endResize 直接放进 deps：它的依赖里有 `config.storageKey`，
   * 调用方传内联 config 时每次渲染都会换身份 → 这个"卸载清理" effect 会在**每次渲染**都跑一遍
   * （实测：无关 re-render 会触发一次 endResize，把进行中的手势提前结束）。
   * 这里要的语义就是"只在卸载时收尾一次"，所以固定成 [] 依赖 + ref 取最新实现。
   */
  const endResizeRef = useRef(endResize);
  useEffect(() => {
    endResizeRef.current = endResize;
  }, [endResize]);

  // 清理：卸载时必须结束手势 —— 否则组件没了、监听器和 body class 还在
  useEffect(() => {
    return () => {
      endResizeRef.current();
    };
  }, []);

  return { width, isResizing, onResizeStart, setWidth, endResize };
}
