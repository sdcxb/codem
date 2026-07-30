/**
 * CorrectionModeToggle — 事实核查模式开关
 *
 * 位置：ChatPanel 顶部（类似 Reasoning 开关）
 * 作用：开启 Correction 模式后，AI 回复完成后调用 fact_check 工具进行事实核查
 */

import { memo } from "react";
import { useProjectStore } from "../core/store";
import { useLang, S } from "../core/i18n/lang";

interface CorrectionModeToggleProps {
  /** Session ID for persistence */
  sessionId: string;
  /** When enabled, correction mode is active */
  onEnabledChange: (enabled: boolean) => void;
}

export const CorrectionModeToggle = memo(function CorrectionModeToggle({
  sessionId,
  onEnabledChange,
}: CorrectionModeToggleProps) {
  const lang = useLang();
  const { currentSession, updateSession } = useProjectStore();

  const isEnabled = currentSession?.correctionMode === 1;

  const handleToggle = () => {
    const newState = !isEnabled;
    if (currentSession) {
      updateSession(currentSession.id, { correctionMode: newState ? 1 : 0 });
      onEnabledChange(newState);
    }
  };

  return (
    <button
      className={`correction-mode-toggle ${isEnabled ? "enabled" : ""}`}
      onClick={handleToggle}
      title={S.correctionMode.tooltip[lang]}
    >
      <span className="toggle-icon">🔍</span>
      <span className="toggle-label">{S.correctionMode.label[lang]}</span>
    </button>
  );
});