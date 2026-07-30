/**
 * PromptDraftPicker — Prompt 草稿版本选择器
 *
 * 显示 Prompt 草稿版本列表，支持版本对比、A/B 测试
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";
import type { PromptDraft } from "../core/storage/prompt-draft";

interface PromptDraftPickerProps {
  /** Available drafts */
  drafts: PromptDraft[];
  /** When user selects a draft to load */
  onSelect: (draft: PromptDraft) => void;
  /** Close picker */
  onClose: () => void;
}

export const PromptDraftPicker = memo(function PromptDraftPicker({
  drafts,
  onSelect,
  onClose,
}: PromptDraftPickerProps) {
  const lang = useLang();
  const [compareMode, setCompareMode] = useState<PromptDraft[] | null>(null);

  const handleCompare = (a: PromptDraft, b: PromptDraft) => {
    setCompareMode([a, b]);
  };

  const closeCompare = () => {
    setCompareMode(null);
  };

  if (compareMode) {
    return (
      <div className="prompt-draft-picker compare-mode">
        <div className="compare-header">
          <h3>{S.promptDraft.compareTitle[lang]}</h3>
          <button className="compare-close" onClick={closeCompare}>✕</button>
        </div>
        <div className="compare-content">
          <div className="compare-side">
            <div className="compare-header-side">{S.promptDraft.version[lang]} {compareMode[0].version}</div>
            <pre className="compare-text">{compareMode[0].content}</pre>
            <button
              className="compare-select-btn"
              onClick={() => onSelect(compareMode[0])}
            >
              {S.promptDraft.useThis[lang]}
            </button>
          </div>
          <div className="compare-side">
            <div className="compare-header-side">{S.promptDraft.version[lang]} {compareMode[1].version}</div>
            <pre className="compare-text">{compareMode[1].content}</pre>
            <button
              className="compare-select-btn"
              onClick={() => onSelect(compareMode[1])}
            >
              {S.promptDraft.useThis[lang]}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prompt-draft-picker">
      <div className="draft-header">
        <h3>{S.promptDraft.title[lang]}</h3>
        <button className="draft-close" onClick={onClose}>✕</button>
      </div>

      <div className="draft-list">
        {drafts.map((draft, index) => (
          <div key={draft.id} className="draft-item">
            <div className="draft-info">
              <span className="draft-version">{S.promptDraft.version[lang]} {draft.version}</span>
              <span className="draft-date">
                {new Date(draft.createdAt).toLocaleDateString()}
              </span>
              {draft.tags.map((tag) => (
                <span key={tag} className="draft-tag">{tag}</span>
              ))}
            </div>
            <div className="draft-preview">{draft.content.slice(0, 100)}...</div>
            <div className="draft-actions">
              <button
                className="draft-btn load"
                onClick={() => onSelect(draft)}
              >
                {S.promptDraft.load[lang]}
              </button>
              {index > 0 && (
                <button
                  className="draft-btn compare"
                  onClick={() => handleCompare(drafts[index - 1], draft)}
                >
                  {S.promptDraft.compare[lang]}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});