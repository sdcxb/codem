/**
 * RegenerateModelPopover — 重新生成模型选择器
 *
 * 用户点击"重新生成"时，可以选择不同的模型重新生成回复。
 * 根据 mode（cli / api）从公共模块获取可用模型列表。
 */

import { memo, useRef, useEffect } from "react";
import { useLang, S } from "../core/i18n/lang";
import { getModelsForMode, type ModelOption } from "../core/model-config";

interface RegenerateModelPopoverProps {
  /** Current model */
  currentModel: string;
  /** Mode: "cli" or "api" — determines which model list to show */
  mode?: "cli" | "api";
  /** When user selects a model */
  onModelSelect: (model: string) => void;
  /** Popover close callback */
  onClose: () => void;
}

export const RegenerateModelPopover = memo(function RegenerateModelPopover({
  currentModel,
  mode = "cli",
  onModelSelect,
  onClose,
}: RegenerateModelPopoverProps) {
  const lang = useLang();
  const popoverRef = useRef<HTMLDivElement>(null);
  const models: ModelOption[] = getModelsForMode(mode);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return (
    <div className="regenerate-popover" ref={popoverRef}>
      <div className="regenerate-header">{S.regenerateModel.title[lang]}</div>
      <div className="regenerate-list">
        {models.map((model) => (
          <button
            key={model.id}
            className={`regenerate-option ${currentModel === model.id ? "selected" : ""}`}
            onClick={() => onModelSelect(model.id)}
          >
            <div className="regenerate-model-name">{model.name}</div>
            {currentModel === model.id && <span className="regenerate-check">✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
});
