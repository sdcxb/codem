import { useState, useRef, useEffect, useCallback } from "react";
import { useLang, S } from "../core/i18n/lang";

interface InlineMessageEditProps {
  /** Initial content to populate the textarea */
  initialContent: string;
  /** Called when user confirms the edit */
  onSave: (newContent: string) => void;
  /** Called when user cancels the edit */
  onCancel: () => void;
}

/**
 * Inline message editor — replaces a message bubble with a textarea.
 * Used for the "edit & resend" feature: user edits a past message,
 * and the conversation is re-run from that point.
 */
export function InlineMessageEdit({ initialContent, onSave, onCancel }: InlineMessageEditProps) {
  const lang = useLang();
  const [content, setContent] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus and position cursor at end
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // Auto-resize
    autoResize(ta);
  }, []);

  // Auto-resize textarea based on content
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    autoResize(e.target);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter to save (without shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (content.trim()) {
        onSave(content.trim());
      }
    }
    // Escape to cancel
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const canSave = content.trim().length > 0 && content.trim() !== initialContent.trim();

  return (
    <div className="inline-edit-container">
      <textarea
        ref={textareaRef}
        className="inline-edit-textarea"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder={lang === "zh" ? "编辑消息内容..." : "Edit message content..."}
      />
      <div className="inline-edit-actions">
        <button
          className="inline-edit-btn save"
          disabled={!canSave}
          onClick={() => canSave && onSave(content.trim())}
        >
          ✓ {S.bubble.save[lang]}
        </button>
        <button
          className="inline-edit-btn cancel"
          onClick={onCancel}
        >
          ✕ {S.bubble.cancel[lang]}
        </button>
      </div>
      <div className="inline-edit-hint">
        {lang === "zh"
          ? "Enter 保存 · Esc 取消 · Shift+Enter 换行"
          : "Enter to save · Esc to cancel · Shift+Enter for newline"}
      </div>
    </div>
  );
}
