import { memo, useEffect, useRef, useState } from "react";
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
  containerRef,
  messagesEndRef,
}: ScrollToBottomIndicatorProps) {
  const lang = useLang();
  const scrollPosition = useAppStore((s) => s.scrollPosition);
  const hasUnreadMessages = useAppStore((s) => s.hasUnreadMessages);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const setScrollPosition = useAppStore((s) => s.setScrollPosition);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /*
   * 只在「滚上去了」**且容器真的能滚**时显示。
   *
   * 真机教训（Batch 7 收口截图）：新对话空状态里也冒出这个按钮，正好压住最后一张
   * 快速访问卡片的描述文字。原因是 scrollPosition 是**上一个会话**留下的
   * scrolled-up（store 常驻），而空状态根本没有可滚内容。
   * 判据：容器 scrollHeight - clientHeight > 24 才算「能滚」。
   */
  const [hasOverflow, setHasOverflow] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      setHasOverflow(false);
      return;
    }
    setHasOverflow(el.scrollHeight - el.clientHeight > 24);
  }, [containerRef, scrollPosition]);

  const shouldShow = scrollPosition === "scrolled-up" && hasOverflow;

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
