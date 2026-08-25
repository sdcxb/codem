import { useEffect, useCallback, useRef } from "react";
import { useAppStore, type ScrollPosition } from "../store";

const BOTTOM_THRESHOLD = 80; // px from bottom to be considered "at bottom"
const NEAR_BOTTOM_THRESHOLD = 200; // px from bottom to be considered "near bottom"

/**
 * Hook to track scroll position of a container and sync it to the store.
 * Used by ScrollToBottomIndicator and ScrollbarMarkers.
 */
export function useScrollState(
  containerRef: React.RefObject<HTMLDivElement | null>,
  deps: React.DependencyList = []
) {
  const setScrollPosition = useAppStore((s) => s.setScrollPosition);
  const setHasUnreadMessages = useAppStore((s) => s.setHasUnreadMessages);
  const scrollPositionRef = useRef<ScrollPosition>("bottom");

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // .chat-body 是真正的滚动容器，.messages-container 不滚动
    const scrollEl = container.parentElement || container;

    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    let newPos: ScrollPosition;
    if (distanceFromBottom <= BOTTOM_THRESHOLD) {
      newPos = "bottom";
    } else if (distanceFromBottom <= NEAR_BOTTOM_THRESHOLD) {
      newPos = "near-bottom";
    } else {
      newPos = "scrolled-up";
    }

    // Only update store if position changed
    if (newPos !== scrollPositionRef.current) {
      scrollPositionRef.current = newPos;
      setScrollPosition(newPos);
    }
  }, [containerRef, setScrollPosition]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollEl = container.parentElement || container;

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    // Initial check
    handleScroll();

    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, handleScroll, ...deps]);

  return { handleScroll };
}

/**
 * Hook to mark unread messages when new messages arrive while scrolled up.
 */
export function useUnreadMessagesTracker(messageCount: number, isStreaming: boolean) {
  const scrollPosition = useAppStore((s) => s.scrollPosition);
  const setHasUnreadMessages = useAppStore((s) => s.setHasUnreadMessages);
  const prevCountRef = useRef(messageCount);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    prevCountRef.current = messageCount;

    // If new messages arrived and user is scrolled up, mark as unread
    if (messageCount > prevCount && scrollPosition === "scrolled-up") {
      setHasUnreadMessages(true);
    }
    // If user is at bottom, clear unread flag
    if (scrollPosition === "bottom" || scrollPosition === "near-bottom") {
      setHasUnreadMessages(false);
    }
  }, [messageCount, scrollPosition, isStreaming, setHasUnreadMessages]);
}
