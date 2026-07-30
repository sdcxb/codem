/**
 * GenerateModeSelector — 生成模式选择器（文本/图像/视频）
 *
 * 用户选择 AI 生成的内容类型
 */

import { memo } from "react";
import { useLang, S } from "../core/i18n/lang";

type GenerateMode = "text" | "image" | "video";

interface GenerateModeSelectorProps {
  /** Current mode */
  mode: GenerateMode;
  /** Mode change callback */
  onModeChange: (mode: GenerateMode) => void;
}

export const GenerateModeSelector = memo(function GenerateModeSelector({
  mode,
  onModeChange,
}: GenerateModeSelectorProps) {
  const lang = useLang();

  const modes: { value: GenerateMode; icon: string; label: string }[] = [
    { value: "text", icon: "📝", label: S.generateMode.text[lang] },
    { value: "image", icon: "🖼️", label: S.generateMode.image[lang] },
    { value: "video", icon: "🎬", label: S.generateMode.video[lang] },
  ];

  return (
    <div className="generate-mode-selector">
      {modes.map((m) => (
        <button
          key={m.value}
          className={`mode-option ${mode === m.value ? "active" : ""}`}
          onClick={() => onModeChange(m.value)}
        >
          <span className="mode-icon">{m.icon}</span>
          <span className="mode-label">{m.label}</span>
        </button>
      ))}
    </div>
  );
});