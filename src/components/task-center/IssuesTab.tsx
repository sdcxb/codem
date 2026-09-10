/**
 * IssuesTab — Issue 列表视图
 *
 * 支持：列表视图 + 新建 Issue + 筛选
 */

import { useState, useEffect, useCallback } from "react";
import { ClipboardList } from "lucide-react";
import { ActionIcons } from "../../core/icons/icon-map";
import { getIssueManager, type Issue } from "../../core/issue/issue";
import type { IssueStatus } from "../../core/issue/issue-storage";
import { useLang } from "../../core/i18n/lang";
import { getCurrentProjectId, useCurrentProjectId } from "./use-current-project";
import { IssueCard } from "./IssueCard";
import { IssueDetailPanel } from "./IssueDetailPanel";

const STATUS_FILTERS: { value: IssueStatus | "all"; labelZh: string; labelEn: string }[] = [
  { value: "all", labelZh: "全部", labelEn: "All" },
  { value: "backlog", labelZh: "Backlog", labelEn: "Backlog" },
  { value: "todo", labelZh: "待办", labelEn: "Todo" },
  { value: "in_progress", labelZh: "进行中", labelEn: "In Progress" },
  { value: "in_review", labelZh: "待审查", labelEn: "In Review" },
  { value: "done", labelZh: "已完成", labelEn: "Done" },
  { value: "blocked", labelZh: "阻塞", labelEn: "Blocked" },
  { value: "cancelled", labelZh: "已取消", labelEn: "Cancelled" },
];

interface IssuesTabProps {
  /** 外部请求聚焦某个 Issue（收件箱点击穿透 → 直接打开详情） */
  focusIssueId?: string | null;
  /** 聚焦请求已消费的回调（避免切回页签时重复打开同一详情） */
  onFocusConsumed?: () => void;
}

export function IssuesTab({ focusIssueId, onFocusConsumed }: IssuesTabProps = {}) {
  const lang = useLang();
  const zh = lang === "zh";
  const [issues, setIssues] = useState<Issue[]>([]);
  const [filter, setFilter] = useState<IssueStatus | "all">("all");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const projectId = useCurrentProjectId();

  const loadIssues = useCallback(() => {
    const mgr = getIssueManager();
    const pid = getCurrentProjectId();
    // 无项目时不查库：storage 层 projectId 为空会返回全部项目的数据（P2-12）
    setIssues(pid ? mgr.list({ projectId: pid, status: filter === "all" ? undefined : filter }) : []);
    // projectId 进依赖：切换项目时必须重查，否则会显示上一个项目的 Issue
  }, [filter, projectId]);

  useEffect(() => {
    loadIssues();
    const mgr = getIssueManager();
    const unsub = mgr.onIssueChange(() => loadIssues());
    return () => { unsub(); };
  }, [loadIssues]);

  // 收件箱点击穿透：请求聚焦的 Issue 直接打开详情（并清掉可能挡住它的状态筛选）
  useEffect(() => {
    if (!focusIssueId) return;
    setFilter("all");
    setSelectedIssueId(focusIssueId);
    onFocusConsumed?.();
  }, [focusIssueId, onFocusConsumed]);

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    const mgr = getIssueManager();
    const projectId = getCurrentProjectId();
    // 无项目不创建：否则会生成 project_id = null 的孤儿 Issue（P2-12）
    if (!projectId) return;
    mgr.create({ title: newTitle, description: newDesc, projectId });
    setNewTitle("");
    setNewDesc("");
    setCreating(false);
    // 新建的 Issue 状态固定为 todo：若当前筛选是别的状态，切回「全部」让用户看到它
    if (filter !== "all") setFilter("all");
    loadIssues();
  };

  const selectedIssue = selectedIssueId ? getIssueManager().get(selectedIssueId) : null;

  // If an issue is selected, show the detail panel
  if (selectedIssue) {
    return (
      <IssueDetailPanel
        issue={selectedIssue}
        onClose={() => setSelectedIssueId(null)}
        onRefresh={loadIssues}
      />
    );
  }

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ClipboardList size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--text-primary)" }}>
            Issues ({issues.length})
          </span>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          disabled={!projectId}
          title={projectId ? undefined : (zh ? "请先选择或创建一个项目" : "Select or create a project first")}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 14px", borderRadius: 6, fontSize: 'var(--fs-base)',
            border: "1px solid var(--accent)", background: "var(--accent)",
            color: "#fff", cursor: projectId ? "pointer" : "not-allowed",
            opacity: projectId ? 1 : 0.5,
          }}
        >
          {creating ? <ActionIcons.close size={14} /> : <ActionIcons.add size={14} />}
          {zh ? "新建 Issue" : "New Issue"}
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div style={{
          marginBottom: 16, padding: 16, borderRadius: 8,
          border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
        }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={zh ? "Issue 标题..." : "Issue title..."}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 4,
              border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
              color: "var(--text-primary)", fontSize: 'var(--fs-md)', marginBottom: 8,
            }}
            autoFocus
          />
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder={zh ? "详细描述（可选）..." : "Description (optional)..."}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 4,
              border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
              color: "var(--text-primary)", fontSize: 'var(--fs-base)', minHeight: 80,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim()}
              style={{
                padding: "6px 16px", borderRadius: 4, fontSize: 'var(--fs-sm)',
                border: "1px solid var(--accent)", background: "var(--accent)",
                color: "#fff", cursor: "pointer", opacity: newTitle.trim() ? 1 : 0.5,
              }}
            >
              {zh ? "创建" : "Create"}
            </button>
            <button
              onClick={() => { setCreating(false); setNewTitle(""); setNewDesc(""); }}
              style={{
                padding: "6px 16px", borderRadius: 4, fontSize: 'var(--fs-sm)',
                border: "1px solid var(--border-primary)", background: "none",
                color: "var(--text-primary)", cursor: "pointer",
              }}
            >
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", flexWrap: "wrap" }}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 'var(--fs-sm)',
              border: `1px solid ${filter === f.value ? "var(--accent)" : "var(--border-primary)"}`,
              background: filter === f.value ? "var(--accent)22" : "none",
              color: filter === f.value ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {zh ? f.labelZh : f.labelEn}
          </button>
        ))}
      </div>

      {/* Issue list */}
      {issues.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "var(--fs-md)" }}>
          {projectId
            ? (zh ? "暂无 Issue。" : "No issues found.")
            : (zh ? "尚未选择项目，Issue 需要归属到某个项目。" : "No project selected — issues are project-scoped.")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              onClick={() => setSelectedIssueId(issue.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
