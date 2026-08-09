/**
 * MentionAutocomplete — @ 提及自动补全
 *
 * 对标 frakio-work MentionAutocomplete + wecode ComposerTextarea autocomplete
 * 输入 @ 时弹出文件列表，支持过滤选择
 */

import { memo, useState, useEffect, useRef, useCallback } from "react";
import { useLang } from "../core/i18n/lang";
import { FileText, FileCode, FileImage, Folder, Search } from "lucide-react";

export interface MentionItem {
  id: string;
  type: "file" | "folder" | "notebook";
  label: string;
  /** Full path for reference */
  path?: string;
  icon?: string;
}

interface MentionAutocompleteProps {
  /** Available mention items */
  items: MentionItem[];
  /** Current filter query (text after @) */
  query: string;
  /** When user selects an item */
  onSelect: (item: MentionItem) => void;
  /** When user closes the menu */
  onClose: () => void;
}

export const MentionAutocomplete = memo(function MentionAutocomplete({
  items,
  query,
  onSelect,
  onClose,
}: MentionAutocompleteProps) {
  const lang = useLang();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter items based on query
  const filtered = items.filter((item) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      (item.path || "").toLowerCase().includes(q)
    );
  });

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [filtered, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      `[data-mention-index="${selectedIndex}"]`
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (filtered.length === 0) {
    return (
      <div className="mention-autocomplete">
        <div className="mention-header">
          <Search size={12} />
          <span>{lang === "zh" ? "提及文件" : "Mention file"}</span>
        </div>
        <div className="mention-empty">
          {lang === "zh" ? "未找到匹配的文件" : "No matching files"}
          {query && (
            <span className="mention-query-hint">
              {" "}— @{query}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mention-autocomplete" ref={listRef}>
      <div className="mention-header">
        <Search size={12} />
        <span>{lang === "zh" ? `提及文件 (${filtered.length})` : `Mention file (${filtered.length})`}</span>
      </div>
      <ul className="mention-list">
        {filtered.slice(0, 20).map((item, index) => (
          <li
            key={item.id}
            data-mention-index={index}
            className={`mention-item ${index === selectedIndex ? "selected" : ""}`}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => onSelect(item)}
          >
            <span className="mention-icon">{getMentionIcon(item)}</span>
            <div className="mention-content">
              <span className="mention-label">{item.label}</span>
              {item.path && (
                <span className="mention-path">{item.path}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
});

function getMentionIcon(item: MentionItem) {
  if (item.icon) return item.icon;
  if (item.type === "folder") return <Folder size={14} />;
  const ext = item.label.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return <FileImage size={14} />;
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "css", "html", "json", "md"].includes(ext)) return <FileCode size={14} />;
  return <FileText size={14} />;
}
