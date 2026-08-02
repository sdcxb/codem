import { memo, useRef } from "react";
import { useAppStore } from "../store";
import { useLang, S } from "../core/i18n/lang";

interface ScrollToBottomIndicatorProps {
  /** Ref to the scrollable container — used to scroll to bottom */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The end-of-messages ref to scrollIntoView */
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Floating "scroll to bottom" button — appears when the user has
 * scrolled up and there are new messages below.
 */
export const ScrollToBottomIndicator = memo(function ScrollToBottomIndicator({
  messagesEndRef,
}: ScrollToBottomIndicatorProps) {
  const lang = useLang();
  const scrollPosition = useAppStore((s) => s.scrollPosition);
  const hasUnreadMessages = useAppStore((s) => s.hasUnreadMessages);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const setScrollPosition = useAppStore((s) => s.setScrollPosition);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Only show when scrolled up
  const shouldShow = scrollPosition === "scrolled-up";

  if (!shouldShow) return null;

  const handleClick = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setScrollPosition("bottom");
  };

  return (
    <div className="scroll-to-bottom-wrapper">
      <button
        ref={buttonRef}
        className={`scroll-to-bottom-btn ${hasUnreadMessages ? "has-unread" : ""} ${
          isStreaming ? "streaming" : ""
        }`}
        onClick={handleClick}
        aria-label={S.scroll.scrollToBottom[lang]}
        style={{
          background: "var(--dream-panel-bg, var(--bg-secondary))",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
        }}
      >
        <span className="scroll-arrow">↓</span>
        {hasUnreadMessages && (
          <span className="unread-badge" />
        )}
      </button>
      {hasUnreadMessages && (
        <span className="unread-label">
          {S.scroll.newMessages[lang]}
        </span>
      )}
    </div>
  );
});
