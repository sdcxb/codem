/**
 * IssueBoard — Issues 看板（按状态分列，可拖拽改状态）。
 *
 * 从 `BoardTab` 中抽出：任务管理「看板」页签的**基础视图**。
 * 当 `@codem/ui-library-ops` 启用时，该页签由插件接管（提供「看板 + 场景 + 用量 …」
 * 视图切换），插件用本组件渲染其中的「看板」视图；插件关闭时回退到本组件。
 */

import { useState, useEffect, useCallback } from "react";
import { getIssueManager, type Issue } from "../../core/issue/issue";
import type { IssueStatus } from "../../core/issue/issue-storage";
import { useLang } from "../../core/i18n/lang";
import { IssueCard } from "./IssueCard";
import { getCurrentProjectId, useCurrentProjectId } from "./use-current-project";

/** 所有 IssueStatus 都必须有一列，否则该状态的 issue 会在看板上"消失" */
const COLUMNS: { status: IssueStatus; labelZh: string; labelEn: string; color: string }[] = [
  { status: "backlog", labelZh: "Backlog", labelEn: "Backlog", color: "var(--text-muted)" },
  { status: "todo", labelZh: "待办", labelEn: "Todo", color: "var(--accent)" },
  { status: "in_progress", labelZh: "进行中", labelEn: "In Progress", color: "var(--accent)" },
  { status: "in_review", labelZh: "待审查", labelEn: "In Review", color: "var(--warning)" },
  { status: "blocked", labelZh: "阻塞", labelEn: "Blocked", color: "var(--error)" },
  { status: "done", labelZh: "已完成", labelEn: "Done", color: "var(--success)" },
  { status: "cancelled", labelZh: "已取消", labelEn: "Cancelled", color: "var(--text-muted)" },
];

export function IssueBoard() {
  const lang = useLang();
  const zh = lang === "zh";
  const [issues, setIssues] = useState<Issue[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<IssueStatus | null>(null);
  const projectId = useCurrentProjectId();

  const loadIssues = useCallback(() => {
    const mgr = getIssueManager();
    const pid = getCurrentProjectId();
    // 无项目时不查库（否则会看到全部项目的 Issue，P2-12）；
    // projectId 进依赖：切换项目时必须重查
    setIssues(pid ? mgr.list({ projectId: pid }) : []);
  }, [projectId]);

  useEffect(() => {
    loadIssues();
    const mgr = getIssueManager();
    const unsub = mgr.onIssueChange(() => loadIssues());
    return () => {
      unsub();
    };
  }, [loadIssues]);

  const handleDragStart = (e: React.DragEvent, issueId: string) => {
    setDraggedId(issueId);
    e.dataTransfer.effectAllowed = "move";
    // WebKit/Firefox 需要 setData 才会真正开始拖拽
    try {
      e.dataTransfer.setData("text/plain", issueId);
    } catch {
      /* 忽略 */
    }
  };

  const handleDragOver = (e: React.DragEvent, status: IssueStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== status) setDragOverCol(status);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // 指针跨过子元素（卡片）时不要闪断高亮
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDragOverCol(null);
  };

  const handleDrop = (e: React.DragEvent, targetStatus: IssueStatus) => {
    e.preventDefault();
    setDragOverCol(null);
    const id = draggedId || (() => {
      try {
        return e.dataTransfer.getData("text/plain") || null;
      } catch {
        return null;
      }
    })();
    setDraggedId(null);
    if (!id) return;
    // 拖回原列不算状态变更（否则 IssueManager 会写一条假的状态变更评论 + 收件箱通知）
    const current = issues.find((i) => i.id === id);
    if (!current || current.status === targetStatus) return;
    getIssueManager().update(id, { status: targetStatus });
    loadIssues();
  };

  const issuesByStatus = (status: IssueStatus) => issues.filter((i) => i.status === status);

  return (
    <div style={{ padding: "12px", height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", gap: "12px", minHeight: "360px", alignItems: "flex-start" }}>
        {COLUMNS.map((col) => {
          const colIssues = issuesByStatus(col.status);
          const isDragOver = dragOverCol === col.status;
          return (
            <div
              key={col.status}
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.status)}
              style={{
                flex: "1 1 0",
                // 列最小宽度走变量：宿主里默认 180px；插件把看板嵌进「任务管理 → 看板」
                // 时可以在 .lo-board-host 上收紧，让 7 列在宽面板里一屏排完
                minWidth: "var(--issue-col-min, 180px)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                borderRadius: "8px",
                padding: "8px",
                background: isDragOver ? "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))" : "var(--bg-secondary)",
                border: isDragOver ? "1px dashed var(--accent)" : "1px solid var(--border-primary)",
                transition: "background 0.2s, border 0.2s",
              }}
            >
              {/* Column header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  paddingBottom: "8px",
                  borderBottom: `2px solid ${col.color}`,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.color }} />
                <span style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
                  {zh ? col.labelZh : col.labelEn}
                </span>
                <span
                  style={{
                    fontSize: "var(--fs-xs)",
                    color: "var(--text-secondary)",
                    background: "var(--bg-tertiary)",
                    padding: "1px 6px",
                    borderRadius: 3,
                  }}
                >
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
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragOverCol(null);
                    }}
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
