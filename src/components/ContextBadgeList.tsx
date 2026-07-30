/**
 * ContextBadgeList — 上下文徽章
 *
 * 显示当前对话中使用的知识库来源、文件等上下文徽章
 */

import { memo } from "react";
import { useLang, S } from "../core/i18n/lang";

interface ContextBadge {
  id: string;
  type: "notebook" | "file" | "url";
  label: string;
  icon?: string;
}

interface ContextBadgeListProps {
  /** Context badges */
  badges: ContextBadge[];
}

export const ContextBadgeList = memo(function ContextBadgeList({
  badges,
}: ContextBadgeListProps) {
  const lang = useLang();

  if (badges.length === 0) return null;

  return (
    <div className="context-badge-list">
      <span className="context-prefix">{S.context.prefix[lang]}</span>
      {badges.map((badge) => (
        <span key={badge.id} className={`context-badge type-${badge.type}`}>
          {badge.icon || getContextIcon(badge.type)} {badge.label}
        </span>
      ))}
    </div>
  );
});

function getContextIcon(type: string): string {
  const icons = { notebook: "📒", file: "📄", url: "🔗" };
  return icons[type as keyof typeof icons] || "📎";
}