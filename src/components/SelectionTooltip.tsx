import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useLang, S } from "../core/i18n/lang";

interface SelectionTooltipProps {
  containerRef: React.RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}

/**
 * #5: Text selection tooltip
 * Shows a floating "Quote & Ask" button when user selects text in AI messages.
 * Based on Wegent's SelectionTooltip implementation.
 */
export function SelectionTooltip({ containerRef, onQuote }: SelectionTooltipProps) {
  const lang = useLang();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const selectedTextRef = useRef("");

  const updatePosition = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setVisible(false);
      return;
    }

    const text = selection.toString().trim();
    if (!text || text.length < 2) {
      setVisible(false);
      return;
    }

    // Check if selection is within our container
    const container = containerRef.current;
    if (!container) return;

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setVisible(false);
      return;
    }

    selectedTextRef.current = text;
    const rect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Position above the selection, centered
    const top = rect.top - containerRect.top - 40;
    const left = rect.left - containerRect.left + rect.width / 2;

    // Clamp to container bounds
    const clampedLeft = Math.max(80, Math.min(left, containerRect.width - 80));

    setPosition({ top, left: clampedLeft });
    setVisible(true);
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = (e: MouseEvent) => {
      // Small delay to let selection finalize
      setTimeout(updatePosition, 10);
    };

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setVisible(false);
      }
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [containerRef, updatePosition]);

  const handleQuote = useCallback(() => {
    if (selectedTextRef.current) {
      onQuote(selectedTextRef.current);
      setVisible(false);
      window.getSelection()?.removeAllRanges();
    }
  }, [onQuote]);

  if (!visible) return null;

  return createPortal(
    <div
      className="selection-tooltip"
      style={{
        position: "absolute",
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: "translateX(-50%)",
        zIndex: 1200,
      }}
      onMouseDown={(e) => e.preventDefault()} // Prevent losing selection
    >
      <button className="selection-tooltip-btn" onClick={handleQuote}>
        💬 {lang === "zh" ? "引用提问" : "Quote & Ask"}
      </button>
    </div>,
    containerRef.current || document.body
  );
}
