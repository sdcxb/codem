/**
 * IssueCard — Issue 卡片组件（列表 + 看板共用）
 */

import { Circle, CircleDot, CircleSlash, CheckCircle2, AlertTriangle, Ban } from "lucide-react";
import type { Issue } from "../../core/issue/issue";
import type { IssueStatus } from "../../core/issue/issue-storage";
import { useLang } from "../../core/i18n/lang";

const STATUS_CONFIG: Record<IssueStatus, { Icon: typeof Circle; color: string; labelZh: string; labelEn: string }> = {
  backlog: { Icon: Circle, color: "#6b7280", labelZh: "Backlog", labelEn: "Backlog" },
  todo: { Icon: Circle, color: "#6366f1", labelZh: "Todo", labelEn: "Todo" },
  in_progress: { Icon: CircleDot, color: "#3b82f6", labelZh: "进行中", labelEn: "In Progress" },
  in_review: { Icon: AlertTriangle, color: "#f59e0b", labelZh: "待审查", labelEn: "In Review" },
  done: { Icon: CheckCircle2, color: "#10b981", labelZh: "已完成", labelEn: "Done" },
  blocked: { Icon: CircleSlash, color: "#ef4444", labelZh: "阻塞", labelEn: "Blocked" },
  cancelled: { Icon: Ban, color: "#6b7280", labelZh: "已取消", labelEn: "Cancelled" },
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f59e0b",
  normal: "#6366f1",
  low: "#6b7280",
};

interface IssueCardProps {
  issue: Issue;
  onClick?: () => void;
  compact?: boolean;
}

export function IssueCard({ issue, onClick, compact = false }: IssueCardProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const config = STATUS_CONFIG[issue.status];
  const StatusIcon = config.Icon;
  const priorityColor = PRIORITY_COLORS[issue.priority] || PRIORITY_COLORS.normal;

  return (
    <div
      onClick={onClick}
      style={{
        padding: compact ? "8px 10px" : "12px 14px",
        borderRadius: 8,
        background: "var(--bg-tertiary, #181828)",
        border: "1px solid var(--border-color, #2a2a3a)",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        transition: "border-color 0.2s",
        borderLeft: `3px solid ${config.color}`,
      }}
      onMouseEnter={(e) => onClick && (e.currentTarget.style.borderColor = "var(--accent, #7c3aed)")}
      onMouseLeave={(e) => onClick && (e.currentTarget.style.borderColor = "var(--border-color, #2a2a3a)")}
    >
      {/* Header: status icon + title + priority */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
        <StatusIcon size={14} style={{ color: config.color, marginTop: 2, flexShrink: 0 }} />
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", flex: 1, lineHeight: 1.4 }}>
          {issue.title}
        </span>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: priorityColor, flexShrink: 0, marginTop: 6,
        }} title={issue.priority} />
      </div>

      {/* Footer: issue ID + assignee + labels */}
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--text-secondary)" }}>
          <span style={{ fontFamily: "monospace", opacity: 0.7 }}>{issue.id.substring(0, 16)}</span>
          {issue.assigneeId && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "var(--accent, #7c3aed)" }}>@</span>
              {issue.assigneeType}/{issue.assigneeId.substring(0, 12)}
            </span>
          )}
          {issue.labels.length > 0 && issue.labels.slice(0, 3).map((label) => (
            <span key={label} style={{
              padding: "1px 6px", borderRadius: 3,
              background: "var(--bg-secondary, #1e1e2e)", fontSize: "10px",
            }}>{label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export { STATUS_CONFIG };
