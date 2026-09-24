/**
 * RegenerateModelPopover — 重新生成模型选择器
 *
 * 用户点击"重新生成"时，可以选择不同的模型重新生成回复。
 * 根据 mode（cli / api）从公共模块获取可用模型列表。
 *
 * ## ⚠️ 未接线（第 109/110 轮审计结论 —— 这段状态有门禁盯着，别悄悄改）
 *
 * @unwired 未接线：本模块/本组件当前没有任何生产调用方（判据见 tools/audit/reachability-scan.mjs 与白名单）
 * （`tools/audit/reachability-scan.mjs`，从入口 `src/main.tsx` / `src/pet-main.tsx` 做模块解析 + BFS）：
 * 它不在可达集合里，白名单 `tools/audit/reachability-allowlist.json` 里登记的类别是
 * 「**未接线（已定性）**」；`src/test/reachability-gate.test.ts::REACH-5` 会核对
 * "白名单说未接线的条目，文件里必须有这一行 `@unwired` 标记"（免得代码与审计各自漂移）。
 *
 * 说清楚现状，而不是让人猜：
 *  - 「重新生成」这个动作**是活的**（`onRegenerate` 在 `App.tsx` / `ChatPanel` / `ConversationRoot` 里都有）；
 *  - 缺的是"重新生成时**选模型**"的入口与下游参数（现在的重新生成不带模型选择）；
 *  - 所以它是**未接线的增强**，不是死代码：要么接上（需要产品决策 + 给下游传模型的管线），
 *    要么在将来清理时删掉。两种处置都要改这张注释与白名单里的理由。
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
