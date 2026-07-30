/**
 * MentionAutocomplete — @ 提及自动补全
 *
 * 用户输入 @ 时显示可提及的实体（用户、文件等）
 */

import { memo, useState, useRef, useEffect } from "react";
import { useLang, S } from "../core/i18n/lang";

export interface MentionItem {
  id: string;
  type: "user" | "file" | "notebook";
  label: string;
  icon?: string;
}

interface MentionAutocompleteProps {
  /** Available mention items */
  items: MentionItem[];
  /** When user selects an item */
  onSelect: (item: MentionItem) => void;
  /** Callback when user types @ (trigger position) */
  onTrigger: (position: number) => void;
}

export const MentionAutocomplete = memo(function MentionAutocomplete({
  items,
  onSelect,
  onTrigger,
}: MentionAutocompleteProps) {
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const filtered = items.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "@" && !e.shiftKey) {
      const textarea = e.target as HTMLTextAreaElement;
      onTrigger(textarea.selectionStart);
      setVisible(true);
    } else if (e.key === "Escape") {
      setVisible(false);
    }
  };

  // This would be integrated with InputArea's keydown handler
  // Simplified for standalone component

  return (
    <>
      {visible && (
        <div
          className="mention-autocomplete"
          style={{ top: position.top, left: position.left }}
        >
          <div className="mention-header">
            <span>{S.mention.title[lang]}</span>
            <button
              className="mention-close"
              onClick={() => setVisible(false)}
            >
              ✕
            </button>
          </div>
          {filtered.length === 0 ? (
            <div className="mention-empty">{S.mention.noResults[lang]}</div>
          ) : (
            <ul className="mention-list">
              {filtered.slice(0, 5).map((item) => (
                <li
                  key={item.id}
                  className="mention-item"
                  onClick={() => {
                    onSelect(item);
                    setVisible(false);
                  }}
                >
                  <span className="mention-icon">
                    {item.icon || getMentionIcon(item.type)}
                  </span>
                  <span className="mention-label">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
});

function getMentionIcon(type: string): string {
  const icons = { user: "👤", file: "📄", notebook: "📒" };
  return icons[type as keyof typeof icons] || "📎";
}