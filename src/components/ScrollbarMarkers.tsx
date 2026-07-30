import { memo, useState, useEffect, useRef, useCallback } from "react";
import type { Message } from "../store";

interface ScrollbarMarkersProps {
  /** All messages in the current view */
  messages: Message[];
  /** Ref to the scrollable container */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface MarkerPosition {
  messageId: string;
  /** Percentage position from top (0-100) */
  topPercent: number;
  /** Whether this marker is currently in the viewport */
  inViewport: boolean;
}

/**
 * Scrollbar markers — small dots on the right side of the scroll bar
 * that mark the position of each user message. Clicking a marker
 * scrolls to that message (Google Gemini style).
 */
export const ScrollbarMarkers = memo(function ScrollbarMarkers({
  messages,
  containerRef,
}: ScrollbarMarkersProps) {
  const [markers, setMarkers] = useState<MarkerPosition[]>([]);
  const [activeMarker, setActiveMarker] = useState<string | null>(null);

  // Calculate marker positions based on scroll
  const calculatePositions = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    const totalHeight = container.scrollHeight;

    if (totalHeight <= viewportHeight) {
      setMarkers([]);
      return;
    }

    // Find all user message DOM elements
    const userMessageIds = messages.filter((m) => m.role === "user").map((m) => m.id);
    const newMarkers: MarkerPosition[] = [];

    for (const msgId of userMessageIds) {
      const el = container.querySelector(`[data-message-id="${msgId}"]`);
      if (!el) continue;

      const elTop = (el as HTMLElement).offsetTop;
      // Position as percentage of total scrollable content
      const topPercent = totalHeight > 0 ? (elTop / totalHeight) * 100 : 0;

      // Check if in viewport
      const elHeight = (el as HTMLElement).offsetHeight;
      const inViewport = elTop + elHeight > scrollTop && elTop < scrollTop + viewportHeight;

      newMarkers.push({ messageId: msgId, topPercent, inViewport });
    }

    setMarkers(newMarkers);

    // Find the active marker (the topmost in-viewport user message)
    const firstInViewport = newMarkers.find((m) => m.inViewport);
    setActiveMarker(firstInViewport?.messageId || null);
  }, [messages, containerRef]);

  // Recalculate on messages change and on scroll
  useEffect(() => {
    calculatePositions();
    // Small delay to ensure DOM is updated
    const timer = setTimeout(calculatePositions, 100);
    return () => clearTimeout(timer);
  }, [messages, calculatePositions]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      requestAnimationFrame(calculatePositions);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerRef, calculatePositions]);

  const handleMarkerClick = (messageId: string) => {
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (markers.length === 0) return null;

  return (
    <div className="scrollbar-markers">
      {markers.map((marker) => (
        <div
          key={marker.messageId}
          className={`scrollbar-marker ${marker.inViewport ? "in-viewport" : ""} ${
            activeMarker === marker.messageId ? "active" : ""
          }`}
          style={{ top: `${marker.topPercent}%` }}
          onClick={() => handleMarkerClick(marker.messageId)}
          title={messages.find((m) => m.id === marker.messageId)?.content.slice(0, 50) || ""}
        />
      ))}
    </div>
  );
});
