/**
 * GenerateModeSelector — 生成模式选择器（文本/图像/视频）
 *
 * 用户选择 AI 生成的内容类型
 */

import { memo } from "react";
import { Type as TypeIcon, Image as ImageIcon, Clapperboard, type LucideIcon } from "lucide-react";
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

  const modes: { value: GenerateMode; icon: LucideIcon; label: string }[] = [
    { value: "text", icon: TypeIcon, label: S.generateMode.text[lang] },
    { value: "image", icon: ImageIcon, label: S.generateMode.image[lang] },
    { value: "video", icon: Clapperboard, label: S.generateMode.video[lang] },
  ];

  return (
    <div className="generate-mode-selector">
      {modes.map((m) => {
        const Icon = m.icon;
        return (
          <button
            key={m.value}
            className={`mode-option ${mode === m.value ? "active" : ""}`}
            onClick={() => onModeChange(m.value)}
          >
            <span className="mode-icon"><Icon size={16} aria-hidden /></span>
            <span className="mode-label">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
});
