/**
 * SourceSelector — 知识库来源选择器
 *
 * 选择哪些知识库来源用于 RAG 检索
 */

import { memo } from "react";
import { useLang, S } from "../core/i18n/lang";

interface SourceItem {
  id: string;
  name: string;
  type: "notebook" | "file" | "url";
}

interface SourceSelectorProps {
  /** Available sources */
  sources: SourceItem[];
  /** Selected source IDs */
  selectedIds: Set<string>;
  /** Selection change callback */
  onSelectionChange: (selectedIds: Set<string>) => void;
}

export const SourceSelector = memo(function SourceSelector({
  sources,
  selectedIds,
  onSelectionChange,
}: SourceSelectorProps) {
  const lang = useLang();

  const handleToggle = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    onSelectionChange(newSelected);
  };

  return (
    <div className="source-selector">
      <div className="source-header">
        <h4>{S.sourceSelector.title[lang]}</h4>
        <div className="source-count">
          {selectedIds.size} / {sources.length}
        </div>
      </div>
      <div className="source-list">
        {sources.map((source) => (
          <label key={source.id} className="source-item">
            <input
              type="checkbox"
              checked={selectedIds.has(source.id)}
              onChange={() => handleToggle(source.id)}
            />
            <span className="source-type">{getSourceIcon(source.type)}</span>
            <span className="source-name">{source.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
});

function getSourceIcon(type: string): string {
  const icons = { notebook: "📒", file: "📄", url: "🔗" };
  return icons[type as keyof typeof icons] || "📎";
}