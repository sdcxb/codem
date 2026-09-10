/**
 * IssueDetailPanel — Issue 详情面板
 *
 * 展示 Issue 完整信息 + 评论 + 状态变更操作
 *
 * 样式：第 15 波把内联样式收口成 `.issue-detail-*` 具名类（见 src/styles/task-center.css）；
 * 状态/分配按钮的颜色来自 issue-status-meta（数据），因此内联只给 `color`，
 * 底与边由 `currentColor` 派生。
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import { ArrowLeft, Send, Users } from "lucide-react";
import { getIssueManager, type IssueWithComments } from "../../core/issue/issue";
import { getSquadManager } from "../../core/squad/squad";
import type { IssueStatus } from "../../core/issue/issue-storage";
import { useLang } from "../../core/i18n/lang";
import { issueStatusMeta, ISSUE_STATUSES } from "./issue-status-meta";

interface IssueDetailPanelProps {
  issue: IssueWithComments;
  onClose: () => void;
  onRefresh: () => void;
}

const STATUS_OPTIONS: IssueStatus[] = ISSUE_STATUSES;

export function IssueDetailPanel({ issue, onClose, onRefresh }: IssueDetailPanelProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [commentText, setCommentText] = useState("");
  const [currentIssue, setCurrentIssue] = useState(issue);
  const [showSquadPicker, setShowSquadPicker] = useState(false);

  // 父组件拿到的 issue 变了（切换选中 / 订阅到 issue_change）→ 同步本地副本，
  // 否则面板会一直显示打开时的旧快照（agent 侧改状态/加评论看不到）
  useEffect(() => {
    setCurrentIssue(issue);
  }, [issue]);

  const refresh = useCallback(() => {
    const updated = getIssueManager().get(issue.id);
    if (updated) setCurrentIssue(updated);
    onRefresh();
  }, [issue.id, onRefresh]);

  const handleStatusChange = (newStatus: IssueStatus) => {
    // 点「当前状态」不算变更：否则 IssueManager 会写一条假的状态变更评论 + 收件箱通知
    // （看板拖拽已有同样的守卫，这里补齐）
    if (newStatus === currentIssue.status) return;
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

  const availableSquads = useMemo(
    // 只在需要选择器时查库：listSquads() 每个 squad 都要读成员 + 查 AgentRegistry，
    // 放在渲染体里会让评论输入框每次击键都打一串 SQL（N+1）
    () => (showSquadPicker ? getSquadManager().listSquads() : []),
    [showSquadPicker],
  );

  const handleAddComment = () => {
    if (!commentText.trim()) return;
    getIssueManager().addComment(issue.id, {
      authorType: "user",
      content: commentText,
    });
    setCommentText("");
    refresh();
  };

  const config = issueStatusMeta(currentIssue.status);
  const StatusIcon = config.Icon;

  return (
    <div className="issue-detail">
      {/* Back button */}
      <button onClick={onClose} className="issue-detail-back">
        <ArrowLeft size={14} /> {zh ? "返回列表" : "Back to list"}
      </button>

      {/* Title + status */}
      <div className="issue-detail-title-row">
        <StatusIcon size={18} className="issue-detail-status-icon" style={{ color: config.color }} />
        <h2 className="issue-detail-title">
          {currentIssue.title}
        </h2>
      </div>

      {/* Meta info */}
      <div className="issue-detail-meta">
        <span className="issue-detail-meta-mono">{currentIssue.id}</span>
        <span>{zh ? "优先级" : "Priority"}: <strong className="issue-detail-meta-strong">{currentIssue.priority}</strong></span>
        {currentIssue.assigneeId && (
          <span>{zh ? "分配给" : "Assigned to"}: <strong className="issue-detail-meta-accent">{currentIssue.assigneeType}/{currentIssue.assigneeId.substring(0, 16)}</strong></span>
        )}
        {currentIssue.labels.length > 0 && (
          <span>{zh ? "标签" : "Labels"}: {currentIssue.labels.join(", ")}</span>
        )}
      </div>

      {/* Description */}
      {currentIssue.description && (
        <div className="issue-detail-desc">
          {currentIssue.description}
        </div>
      )}

      {/* Status selector */}
      <div style={{ marginBottom: "var(--space-8)" }}>
        <label className="issue-detail-label">
          {zh ? "状态" : "Status"}
        </label>
        <div className="issue-detail-status-row">
          {STATUS_OPTIONS.map((s) => {
            const cfg = issueStatusMeta(s);
            const Icon = cfg.Icon;
            const isActive = currentIssue.status === s;
            return (
              <button
                key={s}
                onClick={() => handleStatusChange(s)}
                className={`issue-detail-chip${isActive ? " is-active" : ""}`}
                style={isActive ? { color: cfg.color } : undefined}
              >
                <Icon size={12} />
                {zh ? cfg.labelZh : cfg.labelEn}
              </button>
            );
          })}
          {/* Assign to Squad button */}
          <button
            onClick={() => setShowSquadPicker(!showSquadPicker)}
            className={`issue-detail-chip issue-detail-chip--squad${currentIssue.squadId ? " is-assigned" : ""}`}
          >
            <Users size={12} />
            {currentIssue.squadId ? (zh ? "已分配 Squad" : "Squad assigned") : (zh ? "分配给 Squad" : "Assign to Squad")}
          </button>
        </div>
        {/* Squad picker dropdown */}
        {showSquadPicker && (
          <div className="issue-detail-picker">
            {availableSquads.length === 0 ? (
              <div className="issue-detail-picker-empty">
                {zh ? "暂无 Squad。请先在 Squads Tab 创建。" : "No squads. Create one in the Squads tab first."}
              </div>
            ) : (
              availableSquads.map((sq) => (
                <div
                  key={sq.id}
                  onClick={() => handleAssignSquad(sq.id)}
                  className="issue-detail-picker-item"
                >
                  <Users size={12} />
                  <span className="issue-detail-picker-name">{sq.name}</span>
                  <span className="issue-detail-picker-meta">{sq.members.length} {zh ? "成员" : "members"}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="issue-detail-comments">
        <div className="issue-detail-section-title">
          {zh ? "活动" : "Activity"} ({currentIssue.comments.length})
        </div>
        {currentIssue.comments.length === 0 ? (
          <div className="issue-detail-empty">
            {zh ? "暂无评论" : "No comments yet"}
          </div>
        ) : (
          <div className="issue-detail-comment-list">
            {currentIssue.comments.map((c) => {
              const isSystem = c.isSystem;
              return (
                <div key={c.id} className={`issue-detail-comment${isSystem ? " is-system" : ""}`}>
                  <div className="issue-detail-comment-head">
                    <span className="issue-detail-comment-author">
                      {c.authorName || c.authorType}
                    </span>
                    <span className="issue-detail-comment-time">
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="issue-detail-comment-body">
                    {c.content}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Comment input */}
      <div className="issue-detail-input-row">
        <input
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAddComment(); } }}
          placeholder={zh ? "添加评论..." : "Add a comment..."}
          className="issue-detail-input"
        />
        <button
          onClick={handleAddComment}
          disabled={!commentText.trim()}
          className="issue-detail-send"
        >
          <Send size={14} /> {zh ? "发送" : "Send"}
        </button>
      </div>
    </div>
  );
}
