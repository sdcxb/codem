import { memo, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Message } from "../store";

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

  const calculatePositions = useCallback(() => {
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

    const userIds = messages.filter((m) => m.role === "user").map((m) => m.id);
    const newMarkers: MarkerPosition[] = [];
    for (const msgId of userIds) {
      const el = container.querySelector<HTMLElement>(`[data-message-id="${msgId}"]`);
      if (!el) continue;
      const elTop = el.offsetTop;
      // Visual position within the visible viewport (clamped to rail bounds)
      const visual = ((elTop - scrollTop) / viewportHeight) * 100;
      const topPercent = Math.max(0, Math.min(100, visual));
      const elHeight = el.offsetHeight;
      const inViewport = elTop + elHeight > scrollTop && elTop < scrollTop + viewportHeight;
      newMarkers.push({ messageId: msgId, topPercent, inViewport, pinned: false });
    }

    // Add pinned (精选) assistant markers on top (gold discs).
    if (pinnedIds && pinnedIds.size > 0) {
      for (const pid of pinnedIds) {
        const el = container.querySelector<HTMLElement>(`[data-message-id="${pid}"]`);
        if (!el) continue;
        const visual = ((el.offsetTop - scrollTop) / viewportHeight) * 100;
        newMarkers.push({
          messageId: pid,
          topPercent: Math.max(0, Math.min(100, visual)),
          inViewport: el.offsetTop + el.offsetHeight > scrollTop && el.offsetTop < scrollTop + viewportHeight,
          pinned: true,
        });
      }
    }

    newMarkers.sort((a, b) => a.topPercent - b.topPercent);
    setMarkers(newMarkers);
    const firstInViewport = newMarkers.find((m) => m.inViewport && !m.pinned);
    setActiveId(firstInViewport?.messageId || null);
  }, [messages, containerRef, pinnedIds]);

  // Recalculate on content / pinned changes (after DOM settles).
  useEffect(() => {
    calculatePositions();
    const t1 = setTimeout(calculatePositions, 60);
    const t2 = setTimeout(calculatePositions, 250);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [messages, pinnedIds, calculatePositions]);

  // Listen to the REAL scroller.
  useEffect(() => {
    const scroller = scrollElRef.current;
    if (!scroller) return;
    const onScroll = () => requestAnimationFrame(calculatePositions);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [calculatePositions, railRect]);

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

  const hovered = hoverId ? messages.find((m) => m.id === hoverId) : null;
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
      {hovered && (
        <div className="scrollbar-marker-preview">
          <div className="scrollbar-marker-preview-role">
            {hovered.role === "user" ? "User" : "📌"}
          </div>
          <div className="scrollbar-marker-preview-text">
            {(hovered.content || "").slice(0, 240) || "(no text)"}
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(rail, document.body);
});
