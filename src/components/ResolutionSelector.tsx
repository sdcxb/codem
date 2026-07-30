/**
 * ResolutionSelector — 分辨率选择器
 *
 * 用于图像/视频生成的分辨率设置
 */

import { memo } from "react";
import { useLang, S } from "../core/i18n/lang";

interface ResolutionSelectorProps {
  /** Current resolution */
  resolution: string;
  /** Resolution change callback */
  onResolutionChange: (resolution: string) => void;
}

export const ResolutionSelector = memo(function ResolutionSelector({
  resolution,
  onResolutionChange,
}: ResolutionSelectorProps) {
  const lang = useLang();

  const resolutions = [
    { value: "1024x1024", label: "1024x1024" },
    { value: "2048x2048", label: "2048x2048" },
    { value: "1920x1080", label: "1920x1080 (16:9)" },
    { value: "1080x1920", label: "1080x1920 (9:16)" },
  ];

  return (
    <div className="resolution-selector">
      <label className="resolution-label">{S.resolution.label[lang]}</label>
      <select
        value={resolution}
        onChange={(e) => onResolutionChange(e.target.value)}
        className="resolution-select"
      >
        {resolutions.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
    </div>
  );
});