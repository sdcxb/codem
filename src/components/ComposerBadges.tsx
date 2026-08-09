/**
 * ComposerBadges — 编辑窗引用标识芯片行
 *
 * 对标 frakio-work InputBadgeDisplay + wecode AttachmentBadges
 * 统一展示：文件引用 / GitHub 链接 / 对话引用 / URL 引用
 */

import { memo } from "react";
import {
  X, FileText, GitBranch, MessageSquare, Link2,
  FileCode, FileImage, File as FileIcon,
} from "lucide-react";

// === Types ===

export interface ComposerBadge {
  id: string;
  type: "file" | "github" | "quote" | "url";
  label: string;
  /** Optional sub-label (e.g. file size, repo name) */
  meta?: string;
  /** Optional icon override */
  icon?: string;
  /** Whether this badge can be removed by user */
  removable?: boolean;
}

interface ComposerBadgesProps {
  badges: ComposerBadge[];
  onRemove?: (id: string) => void;
}

// === Icon resolver ===

function getBadgeIcon(badge: ComposerBadge) {
  if (badge.icon) {
    return badge.icon;
  }
  switch (badge.type) {
    case "github":
      return <GitBranch size={13} />;
    case "quote":
      return <MessageSquare size={13} />;
    case "url":
      return <Link2 size={13} />;
    case "file": {
      const ext = badge.label.split(".").pop()?.toLowerCase() || "";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return <FileImage size={13} />;
      if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "css", "html", "json", "md"].includes(ext)) return <FileCode size={13} />;
      return <FileText size={13} />;
    }
    default:
      return <FileIcon size={13} />;
  }
}

// === Component ===

export const ComposerBadges = memo(function ComposerBadges({
  badges,
  onRemove,
}: ComposerBadgesProps) {
  if (!badges || badges.length === 0) return null;

  return (
    <div className="composer-badges-row">
      {badges.map((badge) => (
        <span
          key={badge.id}
          className={`composer-badge composer-badge-${badge.type}`}
          title={badge.meta ? `${badge.label} · ${badge.meta}` : badge.label}
        >
          <span className="composer-badge-icon">{getBadgeIcon(badge)}</span>
          <span className="composer-badge-label">{badge.label}</span>
          {badge.meta && (
            <span className="composer-badge-meta">{badge.meta}</span>
          )}
          {badge.removable !== false && onRemove && (
            <button
              className="composer-badge-remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(badge.id);
              }}
              aria-label="Remove"
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
});
