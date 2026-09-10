/**
 * IssueCard — Issue 卡片组件（列表 + 看板共用）
 */

import type { Issue } from "../../core/issue/issue";
import { useLang } from "../../core/i18n/lang";
import { ISSUE_STATUS_BY_KEY, issueStatusMeta } from "./issue-status-meta";

/**
 * 状态元数据（图标 / 颜色 / 双语标签）统一来自 `issue-status-meta.ts`。
 * 这里保留 `STATUS_CONFIG` 名称只为兼容既有引用（详情面板）。
 */
export const STATUS_CONFIG = ISSUE_STATUS_BY_KEY;

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "var(--error)",
  high: "var(--warning)",
  normal: "var(--accent)",
  low: "var(--text-muted)",
};

interface IssueCardProps {
  issue: Issue;
  onClick?: () => void;
  compact?: boolean;
}

export function IssueCard({ issue, onClick, compact = false }: IssueCardProps) {
  const lang = useLang();
  const zh = lang === "zh";
  // 未知状态（旧数据 / 手工改过的行）回退到 todo，避免 `undefined.Icon` 崩掉整个应用
  const config = issueStatusMeta(issue.status);
  const StatusIcon = config.Icon;
  const priorityColor = PRIORITY_COLORS[issue.priority] || PRIORITY_COLORS.normal;

  return (
    <div
      onClick={onClick}
      style={{
        padding: compact ? "8px 10px" : "12px 14px",
        borderRadius: "var(--radius)",
        background: "var(--bg-tertiary)",
        border: "1px solid var(--border-primary)",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        transition: "border-color 0.2s",
        borderLeft: `3px solid ${config.color}`,
      }}
      onMouseEnter={(e) => {
        if (!onClick) return;
        e.currentTarget.style.borderTopColor = "var(--accent)";
        e.currentTarget.style.borderRightColor = "var(--accent)";
        e.currentTarget.style.borderBottomColor = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        if (!onClick) return;
        // 只改上/右/下边框，保留左侧 3px 状态色条（改 borderColor 会把它一起覆盖掉）
        e.currentTarget.style.borderTopColor = "var(--border-primary)";
        e.currentTarget.style.borderRightColor = "var(--border-primary)";
        e.currentTarget.style.borderBottomColor = "var(--border-primary)";
      }}
    >
      {/* Header: status icon + title + priority */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
        <StatusIcon size={14} style={{ color: config.color, marginTop: 2, flexShrink: 0 }} />
        <span style={{ fontSize: "var(--fs-base)", fontWeight: 600, color: "var(--text-primary)", flex: 1, lineHeight: 1.4 }}>
          {issue.title}
        </span>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: priorityColor, flexShrink: 0, marginTop: 6,
        }} title={issue.priority} />
      </div>

      {/* Footer: issue ID + assignee + labels */}
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "var(--fs-xs)", color: "var(--text-secondary)" }}>
          <span style={{ fontFamily: "monospace", opacity: 0.7 }}>{issue.id.substring(0, 16)}</span>
          {issue.assigneeId && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--accent)" }}>@</span>
              {issue.assigneeType}/{issue.assigneeId.substring(0, 12)}
            </span>
          )}
          {issue.labels.length > 0 && issue.labels.slice(0, 3).map((label) => (
            <span key={label} style={{
              padding: "1px 6px", borderRadius: "var(--radius-sm)",
              background: "var(--bg-secondary)", fontSize: "var(--fs-xs)",
            }}>{label}</span>
          ))}
        </div>
      )}
    </div>
  );
}
