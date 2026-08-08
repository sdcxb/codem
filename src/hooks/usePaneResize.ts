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

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    startRef.current = { x: e.clientX, width };

    const handleMove = (ev: PointerEvent) => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const delta = ev.clientX - startRef.current.x;
        const next = Math.max(config.min, Math.min(config.max, startRef.current.width + delta));
        setWidth(next);
      });
    };

    const handleUp = () => {
      setIsResizing(false);
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.body.classList.remove("resizing-columns");
      if (config.storageKey) {
        try {
          const finalWidth = Math.max(config.min, Math.min(config.max, startRef.current.width + (event as any)?.clientX - startRef.current.x || width));
          localStorage.setItem(config.storageKey, String(finalWidth));
        } catch {}
      }
    };

    document.body.classList.add("resizing-columns");
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
  }, [width, config.min, config.max, config.storageKey]);

  // 清理
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  return { width, isResizing, onResizeStart, setWidth };
}
