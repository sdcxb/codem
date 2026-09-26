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
    /* 第 166 轮 P2-2（提前做掉）：这一个是"模型正在想/正在跑工具"的**状态变化**，
       此前对读屏完全不可见（全仓 `aria-live` 只有 3 处）。
       `role="status"` + `aria-live="polite"`：播报但不打断用户当前朗读。
       ⚠️ 只在这一处加：流式**正文**逐字更新，挂 aria-live 会让读屏不停念（那是另一种坑）。 */
    <div className="streaming-wait-indicator" role="status" aria-live="polite">
      <div className="wait-icon" aria-hidden="true">{phaseConfig.icon}</div>
      <div className="wait-label">{phaseConfig.label}</div>
      {message && <div className="wait-message">{message}</div>}
      <div className="wait-spinner" aria-hidden="true" />
    </div>
  );
});