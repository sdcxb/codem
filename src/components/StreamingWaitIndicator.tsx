/**
 * StreamingWaitIndicator — 分阶段等待提示
 *
 * 在 AI 响应流式传输时，显示当前阶段状态
 */

import { memo } from "react";
import { useLang, S } from "../core/i18n/lang";
import { Brain, Search, Keyboard, Eye } from "lucide-react";

type WaitPhase = "thinking" | "searching" | "coding" | "reviewing";

interface StreamingWaitIndicatorProps {
  /** Current phase */
  phase: WaitPhase;
  /** Additional context message */
  message?: string;
}

export const StreamingWaitIndicator = memo(function StreamingWaitIndicator({
  phase,
  message,
}: StreamingWaitIndicatorProps) {
  const lang = useLang();

  const phaseConfig = {
    thinking: { icon: <Brain size={16} />, label: S.streaming.thinking[lang] },
    searching: { icon: <Search size={16} />, label: S.streaming.searching[lang] },
    coding: { icon: <Keyboard size={16} />, label: S.streaming.coding[lang] },
    reviewing: { icon: <Eye size={16} />, label: S.streaming.reviewing[lang] },
  }[phase];

  return (
    <div className="streaming-wait-indicator">
      <div className="wait-icon">{phaseConfig.icon}</div>
      <div className="wait-label">{phaseConfig.label}</div>
      {message && <div className="wait-message">{message}</div>}
      <div className="wait-spinner" />
    </div>
  );
});