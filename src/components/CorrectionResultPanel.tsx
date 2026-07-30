/**
 * CorrectionResultPanel — 事实核查结果对比面板
 *
 * 展示左右分屏对比：原始回复 vs 修正后回复
 * 标记差异部分，提供"应用修正"或"保留原回复"按钮
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface CorrectionResultPanelProps {
  /** Original AI response */
  original: string;
  /** Corrected AI response */
  corrected: string;
  /** List of change descriptions */
  changes: string[];
  /** User selected to apply correction */
  onApply: () => void;
  /** User selected to keep original */
  onDismiss: () => void;
}

export const CorrectionResultPanel = memo(function CorrectionResultPanel({
  original,
  corrected,
  changes,
  onApply,
  onDismiss,
}: CorrectionResultPanelProps) {
  const lang = useLang();
  const [activeTab, setActiveTab] = useState<"diff" | "changes">("diff");

  // Simple diff highlighting (in production, use proper diff library)
  const renderDiff = () => {
    if (original === corrected) {
      return <div className="diff-message">{S.correction.noChanges[lang]}</div>;
    }
    return (
      <div className="diff-container">
        <div className="diff-side diff-original">
          <div className="diff-header">{S.correction.original[lang]}</div>
          <pre className="diff-content">{original}</pre>
        </div>
        <div className="diff-side diff-corrected">
          <div className="diff-header">{S.correction.corrected[lang]}</div>
          <pre className="diff-content">{corrected}</pre>
        </div>
      </div>
    );
  };

  const renderChanges = () => {
    if (changes.length === 0) {
      return <div className="diff-message">{S.correction.noChanges[lang]}</div>;
    }
    return (
      <ul className="changes-list">
        {changes.map((change, index) => (
          <li key={index} className="change-item">
            {change}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="correction-result-panel">
      <div className="correction-header">
        <div className="correction-title">{S.correction.title[lang]}</div>
        <div className="correction-tabs">
          <button
            className={`correction-tab ${activeTab === "diff" ? "active" : ""}`}
            onClick={() => setActiveTab("diff")}
          >
            {S.correction.tabDiff[lang]}
          </button>
          <button
            className={`correction-tab ${activeTab === "changes" ? "active" : ""}`}
            onClick={() => setActiveTab("changes")}
          >
            {S.correction.tabChanges[lang]} ({changes.length})
          </button>
        </div>
      </div>

      <div className="correction-content">
        {activeTab === "diff" ? renderDiff() : renderChanges()}
      </div>

      <div className="correction-actions">
        <button className="correction-btn apply" onClick={onApply}>
          ✓ {S.correction.apply[lang]}
        </button>
        <button className="correction-btn dismiss" onClick={onDismiss}>
          ✕ {S.correction.dismiss[lang]}
        </button>
      </div>
    </div>
  );
});