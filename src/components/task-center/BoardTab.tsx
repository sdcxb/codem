/**
 * BoardTab — 看板视图
 *
 * Issues 按状态分列展示，支持拖拽在列间移动（= 状态变更）。
 */

import { useState, useEffect, useCallback } from "react";
import { getIssueManager, type Issue } from "../../core/issue/issue";
import type { IssueStatus } from "../../core/issue/issue-storage";
import { useProjectStore } from "../../core/store";
import { useLang } from "../../core/i18n/lang";
import { IssueCard } from "./IssueCard";

const COLUMNS: { status: IssueStatus; labelZh: string; labelEn: string; color: string }[] = [
  { status: "backlog", labelZh: "Backlog", labelEn: "Backlog", color: "var(--text-muted)" },
  { status: "todo", labelZh: "待办", labelEn: "Todo", color: "var(--accent)" },
  { status: "in_progress", labelZh: "进行中", labelEn: "In Progress", color: "var(--accent)" },
  { status: "in_review", labelZh: "待审查", labelEn: "In Review", color: "var(--warning)" },
  { status: "done", labelZh: "已完成", labelEn: "Done", color: "var(--success)" },
];

export function BoardTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [issues, setIssues] = useState<Issue[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<IssueStatus | null>(null);

  const loadIssues = useCallback(() => {
    const mgr = getIssueManager();
    const projectId = useProjectStore.getState().currentProject?.id;
    setIssues(mgr.list({ projectId }));
  }, []);

  useEffect(() => {
    loadIssues();
    const mgr = getIssueManager();
    const unsub = mgr.onIssueChange(() => loadIssues());
    return () => { unsub(); };
  }, [loadIssues]);

  const handleDragStart = (e: React.DragEvent, issueId: string) => {
    setDraggedId(issueId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, status: IssueStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(status);
  };

  const handleDrop = (e: React.DragEvent, targetStatus: IssueStatus) => {
    e.preventDefault();
    setDragOverCol(null);
    if (!draggedId) return;
    getIssueManager().update(draggedId, { status: targetStatus });
    setDraggedId(null);
    loadIssues();
  };

  const issuesByStatus = (status: IssueStatus) => issues.filter((i) => i.status === status);

  return (
    <div style={{ padding: "16px 20px", height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", gap: "12px", minHeight: "400px", alignItems: "flex-start" }}>
        {COLUMNS.map((col) => {
          const colIssues = issuesByStatus(col.status);
          const isDragOver = dragOverCol === col.status;
          return (
            <div
              key={col.status}
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={() => setDragOverCol(null)}
              onDrop={(e) => handleDrop(e, col.status)}
              style={{
                flex: "1 1 0",
                minWidth: "180px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                borderRadius: "8px",
                padding: "8px",
                background: isDragOver ? "var(--accent)11" : "var(--bg-secondary)",
                border: isDragOver ? "1px dashed var(--accent)" : "1px solid var(--border-primary)",
                transition: "background 0.2s, border 0.2s",
              }}
            >
              {/* Column header */}
              <div style={{
                display: "flex", alignItems: "center", gap: "6px",
                paddingBottom: "8px", borderBottom: `2px solid ${col.color}`,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.color }} />
                <span style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
                  {zh ? col.labelZh : col.labelEn}
                </span>
                <span style={{
                  fontSize: "var(--fs-xs)", color: "var(--text-secondary)",
                  background: "var(--bg-tertiary)", padding: "1px 6px", borderRadius: 3,
                }}>
                  {colIssues.length}
                </span>
              </div>

              {/* Cards */}
              {colIssues.length === 0 ? (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", padding: "12px 8px", textAlign: "center" }}>
                  {zh ? "拖拽 Issue 到此列" : "Drop issues here"}
                </div>
              ) : (
                colIssues.map((issue) => (
                  <div
                    key={issue.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, issue.id)}
                    onDragEnd={() => { setDraggedId(null); setDragOverCol(null); }}
                    style={{ opacity: draggedId === issue.id ? 0.5 : 1, cursor: "grab" }}
                  >
                    <IssueCard issue={issue} compact />
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
