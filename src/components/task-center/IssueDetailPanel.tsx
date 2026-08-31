/**
 * IssueDetailPanel — Issue 详情面板
 *
 * 展示 Issue 完整信息 + 评论 + 状态变更操作
 */

import { useState, useCallback } from "react";
import { ArrowLeft, Send, Users } from "lucide-react";
import { getIssueManager, type IssueWithComments } from "../../core/issue/issue";
import { getSquadManager } from "../../core/squad/squad";
import type { IssueStatus } from "../../core/issue/issue-storage";
import { useLang } from "../../core/i18n/lang";
import { STATUS_CONFIG } from "./IssueCard";

interface IssueDetailPanelProps {
  issue: IssueWithComments;
  onClose: () => void;
  onRefresh: () => void;
}

const STATUS_OPTIONS: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];

export function IssueDetailPanel({ issue, onClose, onRefresh }: IssueDetailPanelProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [commentText, setCommentText] = useState("");
  const [currentIssue, setCurrentIssue] = useState(issue);
  const [showSquadPicker, setShowSquadPicker] = useState(false);

  const refresh = useCallback(() => {
    const updated = getIssueManager().get(issue.id);
    if (updated) setCurrentIssue(updated);
    onRefresh();
  }, [issue.id, onRefresh]);

  const handleStatusChange = (newStatus: IssueStatus) => {
    getIssueManager().update(issue.id, { status: newStatus });
    refresh();
  };

  const handleAssignSquad = (squadId: string) => {
    const result = getIssueManager().assignToSquad(issue.id, squadId);
    if (result.success) {
      setShowSquadPicker(false);
      refresh();
    }
  };

  const availableSquads = getSquadManager().listSquads();

  const handleAddComment = () => {
    if (!commentText.trim()) return;
    getIssueManager().addComment(issue.id, {
      authorType: "user",
      content: commentText,
    });
    setCommentText("");
    refresh();
  };

  const config = STATUS_CONFIG[currentIssue.status];
  const StatusIcon = config.Icon;

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Back button */}
      <button
        onClick={onClose}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: "none", border: "none", color: "var(--text-secondary)",
          cursor: "pointer", fontSize: 13, marginBottom: 16, padding: 0,
        }}
      >
        <ArrowLeft size={14} /> {zh ? "返回列表" : "Back to list"}
      </button>

      {/* Title + status */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "12px" }}>
        <StatusIcon size={18} style={{ color: config.color, marginTop: 2, flexShrink: 0 }} />
        <h2 style={{ fontSize: "var(--fs-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, flex: 1, lineHeight: 1.3 }}>
          {currentIssue.title}
        </h2>
      </div>

      {/* Meta info */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "16px", fontSize: "var(--fs-sm)", color: "var(--text-secondary)", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "monospace" }}>{currentIssue.id}</span>
        <span>{zh ? "优先级" : "Priority"}: <strong style={{ color: "var(--text-primary)" }}>{currentIssue.priority}</strong></span>
        {currentIssue.assigneeId && (
          <span>{zh ? "分配给" : "Assigned to"}: <strong style={{ color: "var(--accent)" }}>{currentIssue.assigneeType}/{currentIssue.assigneeId.substring(0, 16)}</strong></span>
        )}
        {currentIssue.labels.length > 0 && (
          <span>{zh ? "标签" : "Labels"}: {currentIssue.labels.join(", ")}</span>
        )}
      </div>

      {/* Description */}
      {currentIssue.description && (
        <div style={{
          padding: "12px 14px", borderRadius: 8, marginBottom: "16px",
          background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
          fontSize: "var(--fs-base)", color: "var(--text-secondary)", lineHeight: 1.6,
        }}>
          {currentIssue.description}
        </div>
      )}

      {/* Status selector */}
      <div style={{ marginBottom: "16px" }}>
        <label style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px", display: "block" }}>
          {zh ? "状态" : "Status"}
        </label>
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
          {STATUS_OPTIONS.map((s) => {
            const cfg = STATUS_CONFIG[s];
            const Icon = cfg.Icon;
            const isActive = currentIssue.status === s;
            return (
              <button
                key={s}
                onClick={() => handleStatusChange(s)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "4px 10px", borderRadius: 4, fontSize: 11,
                  border: `1px solid ${isActive ? cfg.color : "var(--border-primary)"}`,
                  background: isActive ? `${cfg.color}22` : "none",
                  color: isActive ? cfg.color : "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                <Icon size={12} />
                {zh ? cfg.labelZh : cfg.labelEn}
              </button>
            );
          })}
          {/* Assign to Squad button */}
          <button
            onClick={() => setShowSquadPicker(!showSquadPicker)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "4px 10px", borderRadius: 4, fontSize: 11,
              border: `1px solid ${currentIssue.squadId ? "var(--accent)" : "var(--border-primary)"}`,
              background: currentIssue.squadId ? "var(--accent)22" : "none",
              color: currentIssue.squadId ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer", marginLeft: "auto",
            }}
          >
            <Users size={12} />
            {currentIssue.squadId ? (zh ? "已分配 Squad" : "Squad assigned") : (zh ? "分配给 Squad" : "Assign to Squad")}
          </button>
        </div>
        {/* Squad picker dropdown */}
        {showSquadPicker && (
          <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
            {availableSquads.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px" }}>
                {zh ? "暂无 Squad。请先在 Squads Tab 创建。" : "No squads. Create one in the Squads tab first."}
              </div>
            ) : (
              availableSquads.map((sq) => (
                <div
                  key={sq.id}
                  onClick={() => handleAssignSquad(sq.id)}
                  style={{
                    padding: "6px 10px", borderRadius: 4, fontSize: 12,
                    cursor: "pointer", color: "var(--text-primary)",
                    background: "var(--bg-secondary)", marginBottom: 4,
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent)22")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                >
                  <Users size={12} style={{ color: "var(--accent)" }} />
                  <span style={{ fontWeight: 600 }}>{sq.name}</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{sq.members.length} {zh ? "成员" : "members"}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Comments */}
      <div style={{ flex: 1, overflow: "auto", marginBottom: "12px" }}>
        <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px" }}>
          {zh ? "活动" : "Activity"} ({currentIssue.comments.length})
        </div>
        {currentIssue.comments.length === 0 ? (
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", padding: "8px" }}>
            {zh ? "暂无评论" : "No comments yet"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {currentIssue.comments.map((c) => {
              const isSystem = c.isSystem;
              return (
                <div key={c.id} style={{
                  padding: "8px 12px", borderRadius: 6,
                  background: isSystem ? "var(--bg-secondary)" : "var(--bg-tertiary)",
                  borderLeft: isSystem ? "2px solid var(--text-muted)" : `2px solid ${c.authorType === "agent" ? "var(--accent)" : "var(--accent)"}`,
                  fontSize: "var(--fs-sm)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                    <span style={{ fontWeight: 600, color: isSystem ? "var(--text-muted)" : "var(--text-primary)" }}>
                      {c.authorName || c.authorType}
                    </span>
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ color: isSystem ? "var(--text-muted)" : "var(--text-secondary)" }}>
                    {c.content}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Comment input */}
      <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
        <input
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAddComment(); } }}
          placeholder={zh ? "添加评论..." : "Add a comment..."}
          style={{
            flex: 1, padding: "8px 12px", borderRadius: 6,
            border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
            color: "var(--text-primary)", fontSize: 13,
          }}
        />
        <button
          onClick={handleAddComment}
          disabled={!commentText.trim()}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "8px 14px", borderRadius: 6, fontSize: 13,
            border: "1px solid var(--accent)", background: "var(--accent)",
            color: "#fff", cursor: "pointer", opacity: commentText.trim() ? 1 : 0.5,
          }}
        >
          <Send size={14} /> {zh ? "发送" : "Send"}
        </button>
      </div>
    </div>
  );
}
