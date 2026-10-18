/**
 * 滚动边缘渐隐的 React 接线（几何计算在 `core/ui/edge-fade.ts`，判据在那里）。
 *
 * 用法：
 * ```tsx
 * const fade = useEdgeFade<HTMLDivElement>();
 * <div ref={fade.ref} style={fade.style} className={已有滚动容器的类名}>…</div>
 * ```
 *
 * 注意：mask 会为元素建立**层叠上下文**并裁剪其子元素。所以只用在
 * "纯内容滚动区"（设置内容列 / 工具卡正文）—— 不要用在内部还挂着绝对定位浮层的容器上
 * （例如聊天主列表，那里有选区工具提示与浮层）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  edgeFadeMask,
  edgeFadeStateFromMetrics,
  type EdgeFadeState,
} from "../core/ui/edge-fade";

export interface EdgeFadeBinding<T extends HTMLElement> {
  ref: React.RefObject<T>;
  style: React.CSSProperties;
}

export function useEdgeFade<T extends HTMLElement>(): EdgeFadeBinding<T> {
  const ref = useRef<T>(null);
  const [state, setState] = useState<EdgeFadeState>({ atTop: true, atBottom: true });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = edgeFadeStateFromMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    setState((prev) => (prev.atTop === next.atTop && prev.atBottom === next.atBottom ? prev : next));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [update]);

  const mask = edgeFadeMask(state);
  return { ref, style: { maskImage: mask, WebkitMaskImage: mask } };
}
