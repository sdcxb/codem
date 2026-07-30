/**
 * GuidanceBlock — 引导消息展示块
 *
 * 显示已注入到对话中的引导消息
 * 支持折叠/展开
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface GuidanceBlockProps {
  /** Guidance messages */
  messages: Array<{ id: string; message: string; timestamp: number }>;
}

export const GuidanceBlock = memo(function GuidanceBlock({
  messages,
}: GuidanceBlockProps) {
  const lang = useLang();
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 0) return null;

  return (
    <div className={`guidance-block ${expanded ? "expanded" : ""}`}>
      <button
        className="guidance-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{expanded ? "▼" : "▶"}</span>
        <span>{S.guidance.title[lang]} ({messages.length})</span>
      </button>
      {expanded && (
        <div className="guidance-content">
          {messages.map((msg) => (
            <div key={msg.id} className="guidance-message">
              {msg.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});