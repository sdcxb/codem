/**
 * PipelineNextStepDialog — Pipeline 下一步对话框
 *
 * AI 完成任务后，用户可以选择上下文（文本/知识库/表格）继续下一步
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface PipelineContextItem {
  id: string;
  type: "message" | "notebook" | "table";
  title: string;
  content?: string;
}

interface PipelineNextStepDialogProps {
  /** Available context items */
  contextItems: PipelineContextItem[];
  /** User submitted next step */
  onSubmit: (selectedContext: string[], customPrompt: string, mode: "new" | "append") => void;
  /** User cancelled */
  onDismiss: () => void;
}

export const PipelineNextStepDialog = memo(function PipelineNextStepDialog({
  contextItems,
  onSubmit,
  onDismiss,
}: PipelineNextStepDialogProps) {
  const lang = useLang();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [mode, setMode] = useState<"new" | "append">("new");

  const handleToggle = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSubmit = () => {
    if (selectedIds.length === 0 && !customPrompt.trim()) {
      alert(S.pipeline.selectRequired[lang]);
      return;
    }
    onSubmit(selectedIds, customPrompt.trim(), mode);
  };

  return (
    <div className="pipeline-dialog-overlay">
      <div className="pipeline-dialog">
        <div className="pipeline-header">
          <h3>{S.pipeline.title[lang]}</h3>
          <button className="pipeline-close" onClick={onDismiss}>✕</button>
        </div>

        <div className="pipeline-content">
          <div className="pipeline-section">
            <h4>{S.pipeline.contextTitle[lang]}</h4>
            <div className="context-list">
              {contextItems.map((item) => (
                <label key={item.id} className="context-item">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(item.id)}
                    onChange={() => handleToggle(item.id)}
                  />
                  <div className="context-info">
                    <div className="context-type">
                      {item.type === "message" ? S.pipeline.message[lang] :
                       item.type === "notebook" ? S.pipeline.notebook[lang] :
                       item.type === "table" ? S.pipeline.table[lang] : item.type}
                    </div>
                    <div className="context-title">{item.title}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="pipeline-section">
            <h4>{S.pipeline.promptTitle[lang]}</h4>
            <textarea
              className="pipeline-textarea"
              rows={4}
              placeholder={S.pipeline.promptPlaceholder[lang]}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
            />
          </div>

          <div className="pipeline-section">
            <h4>{S.pipeline.modeTitle[lang]}</h4>
            <div className="mode-selector">
              <label className="mode-option">
                <input
                  type="radio"
                  name="mode"
                  value="new"
                  checked={mode === "new"}
                  onChange={() => setMode("new")}
                />
                <span>{S.pipeline.modeNew[lang]}</span>
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="mode"
                  value="append"
                  checked={mode === "append"}
                  onChange={() => setMode("append")}
                />
                <span>{S.pipeline.modeAppend[lang]}</span>
              </label>
            </div>
          </div>
        </div>

        <div className="pipeline-footer">
          <button className="pipeline-btn submit" onClick={handleSubmit}>
            {S.pipeline.submit[lang]}
          </button>
          <button className="pipeline-btn cancel" onClick={onDismiss}>
            {S.pipeline.cancel[lang]}
          </button>
        </div>
      </div>
    </div>
  );
});