import { memo, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "./ui/portal";
import type { Message } from "../store";
import { isMachineInjectedMessage } from "../core/storage/session";

interface ScrollbarMarkersProps {
  /** All messages in the current view */
  messages: Message[];
  /** Ref to the (non-scrolling) messages container. The real scroll container
   *  is its parent element (`.chat-body`, overflow-y:auto). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Pinned assistant message ids — highlighted as gold discs (dsh-navbar 精选 pin 对标) */
  pinnedIds?: Set<string>;
  /** Called when a pinned marker is clicked (jump + optional focus) */
  onPinClick?: (messageId: string) => void;
}

interface MarkerPosition {
  messageId: string;
  /** Visual top percent within the scroll viewport (0-100, clamped) */
  topPercent: number;
  /** Whether this message is currently inside the visible viewport */
  inViewport: boolean;
  /** Whether this marker represents a pinned (精选) assistant message */
  pinned: boolean;
}

/** Marker rail visual width (matches .scrollbar-marker active size) */
const RAIL_GAP = 10;
/** 相邻消息点的最小中心间距（px）—— 历史密集时避免点完全重叠，保证可读可点 */
const MIN_GAP_PX = 10;

/**
 * Scrollbar markers — right-edge node rail for message navigation.
 *
 * v2 (对标 dsh-navbar / Gemini):
 * - Fixes the geometry bug: the old version bound scroll to `.messages-container`
 *   which does NOT scroll — the real scroller is its parent `.chat-body`.
 * - Rendered through a portal into document.body with fixed positioning, so
 *   ancestor transforms (framer-motion) cannot break marker placement.
 * - Click jumps; hover shows a preview card; wheel cycles through user turns.
 */
export const ScrollbarMarkers = memo(function ScrollbarMarkers({
  messages,
  containerRef,
  pinnedIds,
  onPinClick,
}: ScrollbarMarkersProps) {
  const [markers, setMarkers] = useState<MarkerPosition[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [railRect, setRailRect] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);

  // Resolve the real scroll container: parent of .messages-container (.chat-body).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scroller = container.parentElement as HTMLElement | null;
    scrollElRef.current = scroller;

    const measure = () => {
      if (!scroller) return;
      const r = scroller.getBoundingClientRect();
      setRailRect({ top: r.top + 2, bottom: r.bottom - 2, left: r.right - RAIL_GAP - 6, right: r.right - 4 });
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    if (scroller) ro.observe(scroller);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [containerRef]);

  /**
   * 第 233 轮审计：**内容坐标缓存**（px，相对于内容顶部）。
   *
   * 为什么能省掉流式期间的整列布局：流式是**追加**（`scrollHeight` 变大），
   * 而某条消息的内容坐标 `contentTop` 只有在"它上面的内容变高/变矮"时才变。
   * 于是"id 序列没变"时只需用 `contentTop / totalHeight` 重算百分比 —— **零布局读取**。
   * 只有集合变了（新回合/删除/换 pinned）或 resize 才真的去量（并刷新缓存）。
   *
   * `signatureRef` 是"我上次量的是哪一批"：`userIds|pinnedIds` 的有序拼接。
   */
  const contentTopCacheRef = useRef(new Map<string, number>());
  const viewportCacheRef = useRef(new Map<string, boolean>());
  const signatureRef = useRef<string>("");
  const measureNow = useCallback(() => {
    const container = containerRef.current;
    const scroller = scrollElRef.current;
    if (!container || !scroller) return;

    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight;
    const totalHeight = scroller.scrollHeight;

    if (totalHeight <= viewportHeight) {
      setMarkers([]);
      setActiveId(null);
      return;
    }

    /* 第 198 波：系统提醒（`verify-nudge-…` 等）也是 user 角色，但它们不是用户打的话 —— */
    /* 把它们当用户消息会在滚动条上多出一串假的「User」标记（真机缺陷同源）。 */
    const userIds = messages.filter((m) => m.role === "user" && !isMachineInjectedMessage(m)).map((m) => m.id);
    const pinnedList = pinnedIds ? [...pinnedIds] : [];
    const signature = `${userIds.join("\u0000")}|${pinnedList.join("\u0000")}`;
    /** 集合没变 ⇒ 复用缓存的内容坐标（不读任何布局）；变了就重量这一批 */
    const reuse = signature === signatureRef.current && contentTopCacheRef.current.size > 0;
    if (!reuse) {
      /** 轨道矩形**只在真去量的时候**读（流式增长那条路径一次 layout 都不碰） */
      const scrollerRect = scroller.getBoundingClientRect();
      contentTopCacheRef.current.clear();
      /*
       * 一次 rect 同时拿到"位置"与"是否在视口"两件事：原来每条消息读**两次**
       * `getBoundingClientRect()`（`toContentPercent` 一次、`isInViewport` 一次），
       * 现在只读一次 —— 布局读取减半，语义不变。
       */
      for (const id of [...userIds, ...pinnedList]) {
        if (contentTopCacheRef.current.has(id)) continue;
        const el = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        contentTopCacheRef.current.set(id, rect.top - scrollerRect.top + scrollTop);
        viewportCacheRef.current.set(id, rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom);
      }
      signatureRef.current = signature;
    }

    const viewportCache = viewportCacheRef.current;
    const toPercent = (id: string): number | null => {
      const contentTop = contentTopCacheRef.current.get(id);
      if (contentTop === undefined) return null;
      return Math.max(0, Math.min(100, (contentTop / totalHeight) * 100));
    };

    const newMarkers: MarkerPosition[] = [];
    for (const msgId of userIds) {
      const percent = toPercent(msgId);
      if (percent === null) continue;
      newMarkers.push({
        messageId: msgId,
        topPercent: percent,
        inViewport: viewportCache.get(msgId) ?? false,
        pinned: false,
      });
    }
    for (const pid of pinnedList) {
      const percent = toPercent(pid);
      if (percent === null) continue;
      newMarkers.push({
        messageId: pid,
        topPercent: percent,
        inViewport: viewportCache.get(pid) ?? false,
        pinned: true,
      });
    }

    newMarkers.sort((a, b) => a.topPercent - b.topPercent);

    // 最小间距避让：历史消息密集（或轨道较矮）时相邻点可能完全重叠。
    // 正反两遍扫描把冲突点推开，保证相邻点至少相距 MIN_GAP_PX；
    // 轨道两端放不下时由下方越界保护收拢，仅端点允许少量压缩。
    const minGapPct = (MIN_GAP_PX / Math.max(1, viewportHeight)) * 100;
    if (newMarkers.length > 1 && minGapPct > 0) {
      for (let i = 1; i < newMarkers.length; i++) {
        const minTop = newMarkers[i - 1].topPercent + minGapPct;
        if (newMarkers[i].topPercent < minTop) {
          newMarkers[i] = { ...newMarkers[i], topPercent: minTop };
        }
      }
      for (let i = newMarkers.length - 2; i >= 0; i--) {
        const maxTop = newMarkers[i + 1].topPercent - minGapPct;
        if (newMarkers[i].topPercent > maxTop) {
          newMarkers[i] = { ...newMarkers[i], topPercent: maxTop };
        }
      }
      // 越界保护（端点少量重叠优于溢出 rail）
      for (const m of newMarkers) {
        m.topPercent = Math.max(0, Math.min(100, m.topPercent));
      }
    }

    setMarkers(newMarkers);
    const firstInViewport = newMarkers.find((m) => m.inViewport && !m.pinned);
    setActiveId(firstInViewport?.messageId || null);
  }, [messages, containerRef, pinnedIds]);

  /**
   * 合并成"一帧最多一次"（第 233 轮审计）：
   * 流式 flush（100ms）+ 滚动 + resize 可能在同一帧里各要一次重算 —— 原来每次都真跑一遍。
   */
  const frameRef = useRef(0);
  const scheduleMeasure = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      measureNow();
    });
  }, [measureNow]);
  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  // Recalculate on content / pinned changes (after DOM settles).
  useEffect(() => {
    scheduleMeasure();
    const t1 = setTimeout(scheduleMeasure, 60);
    const t2 = setTimeout(scheduleMeasure, 250);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [messages, pinnedIds, scheduleMeasure]);

  // Listen to the REAL scroller.
  useEffect(() => {
    const scroller = scrollElRef.current;
    if (!scroller) return;
    // P2-10: 滚动回调里的 rAF 句柄必须保存 —— 原实现每帧新建一个 requestAnimationFrame，
    // 卸载后仍然会执行（对已卸载组件 setState + 一堆 DOM 查询），且在快速滚动时
    // 叠加多个待执行帧。这里合并为「最多一个待执行帧」，并在清理中取消。
    let raf = 0;
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        measureNow();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
  }, [measureNow, railRect]);

  const jumpTo = useCallback((messageId: string) => {
    const container = containerRef.current;
    const scroller = scrollElRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!el) return;
    if (scroller) {
      const target = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
      scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [containerRef]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Wheel over the rail cycles to the next/previous user marker.
    e.preventDefault();
    e.stopPropagation();
    const userMarkers = markers.filter((m) => !m.pinned);
    if (userMarkers.length === 0) return;
    const activeIdx = userMarkers.findIndex((m) => m.messageId === activeId);
    const delta = e.deltaY > 0 ? 1 : -1;
    const next = userMarkers[(activeIdx + delta + userMarkers.length) % userMarkers.length];
    jumpTo(next.messageId);
    setActiveId(next.messageId);
  }, [markers, activeId, jumpTo]);

  const hoveredMarker = hoverId ? markers.find((m) => m.messageId === hoverId) : null;
  const hovered = hoveredMarker ? messages.find((m) => m.id === hoveredMarker.messageId) : null;
  if (markers.length === 0 || !railRect) return null;

  const rail = (
    <div
      className="scrollbar-markers-rail"
      style={{ top: railRect.top, bottom: undefined, height: railRect.bottom - railRect.top, left: railRect.left, right: undefined }}
      onWheel={handleWheel}
    >
      {markers.map((marker) => (
        <div
          key={marker.messageId}
          className={`scrollbar-marker ${marker.inViewport ? "in-viewport" : ""} ${
            activeId === marker.messageId && !marker.pinned ? "active" : ""
          } ${marker.pinned ? "pinned" : ""}`}
          style={{ top: `calc(${marker.topPercent}% - 3px)` }}
          onClick={() => {
            if (marker.pinned) { onPinClick?.(marker.messageId); jumpTo(marker.messageId); }
            else jumpTo(marker.messageId);
          }}
          onMouseEnter={() => setHoverId(marker.messageId)}
          onMouseLeave={() => setHoverId(null)}
          title=""
        />
      ))}
      {hoveredMarker && hovered && (
        <div
          className="scrollbar-marker-preview"
          style={{
            top: `calc(${hoveredMarker.topPercent}% )`,
            transform: hoveredMarker.topPercent > 65
              ? "translateY(calc(-100% - 14px))"
              : "translateY(14px)",
          }}
        >
          <div className="scrollbar-marker-preview-role">
            {hovered.role === "user" && !isMachineInjectedMessage(hovered) ? "User" : "📌"}
          </div>
          <div className="scrollbar-marker-preview-text">
            {(hovered.content || "").slice(0, 240) || "(no text)"}
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(rail);
});
