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
import { useProjectStore } from "../../core/store";
import { useLang } from "../../core/i18n/lang";
import { IssueCard } from "./IssueCard";
import { IssueDetailPanel } from "./IssueDetailPanel";

const STATUS_FILTERS: { value: IssueStatus | "all"; labelZh: string; labelEn: string }[] = [
  { value: "all", labelZh: "全部", labelEn: "All" },
  { value: "todo", labelZh: "待办", labelEn: "Todo" },
  { value: "in_progress", labelZh: "进行中", labelEn: "In Progress" },
  { value: "in_review", labelZh: "待审查", labelEn: "In Review" },
  { value: "done", labelZh: "已完成", labelEn: "Done" },
  { value: "blocked", labelZh: "阻塞", labelEn: "Blocked" },
];

export function IssuesTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [issues, setIssues] = useState<Issue[]>([]);
  const [filter, setFilter] = useState<IssueStatus | "all">("all");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  const loadIssues = useCallback(() => {
    const mgr = getIssueManager();
    const projectId = useProjectStore.getState().currentProject?.id;
    setIssues(mgr.list({
      projectId,
      status: filter === "all" ? undefined : filter,
    }));
  }, [filter]);

  useEffect(() => {
    loadIssues();
    const mgr = getIssueManager();
    const unsub = mgr.onIssueChange(() => loadIssues());
    return () => { unsub(); };
  }, [loadIssues]);

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    const mgr = getIssueManager();
    const projectId = useProjectStore.getState().currentProject?.id;
    mgr.create({ title: newTitle, description: newDesc, projectId });
    setNewTitle("");
    setNewDesc("");
    setCreating(false);
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
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
            Issues ({issues.length})
          </span>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 14px", borderRadius: 6, fontSize: 13,
            border: "1px solid var(--accent)", background: "var(--accent)",
            color: "#fff", cursor: "pointer",
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
              color: "var(--text-primary)", fontSize: 14, marginBottom: 8,
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
              color: "var(--text-primary)", fontSize: 13, minHeight: 80,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim()}
              style={{
                padding: "6px 16px", borderRadius: 4, fontSize: 12,
                border: "1px solid var(--accent)", background: "var(--accent)",
                color: "#fff", cursor: "pointer", opacity: newTitle.trim() ? 1 : 0.5,
              }}
            >
              {zh ? "创建" : "Create"}
            </button>
            <button
              onClick={() => { setCreating(false); setNewTitle(""); setNewDesc(""); }}
              style={{
                padding: "6px 16px", borderRadius: 4, fontSize: 12,
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
              padding: "4px 12px", borderRadius: 4, fontSize: 12,
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
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "14px" }}>
          {zh ? "暂无 Issue。" : "No issues found."}
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
