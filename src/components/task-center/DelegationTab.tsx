/**
 * DelegationTab — 委派任务 Tab
 *
 * 复用 DelegationPanel 的核心逻辑，去掉外层弹窗框架。
 * 使用 lucide-react 图标，不用 emoji。
 */

import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, Loader2, XCircle, Timer, Ban, ArrowRight, Link2 } from "lucide-react";
import { getDelegationOrchestrator } from "../../core/session";
import type { DelegationTask, DelegationState } from "../../core/session";
import { useProjectStore } from "../../core/store";
import { useLang } from "../../core/i18n/lang";

const STATUS_CONFIG: Record<DelegationState, { label: string; labelEn: string; color: string; Icon: typeof CheckCircle2 }> = {
  pending: { label: "等待中", labelEn: "Pending", color: "var(--text-muted)", Icon: Timer },
  running: { label: "执行中", labelEn: "Running", color: "var(--accent)", Icon: Loader2 },
  completed: { label: "已完成", labelEn: "Completed", color: "var(--success)", Icon: CheckCircle2 },
  failed: { label: "已失败", labelEn: "Failed", color: "var(--error)", Icon: XCircle },
  cancelled: { label: "已取消", labelEn: "Cancelled", color: "var(--warning)", Icon: Ban },
};

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function getSessionTitle(sessions: any[], sessionId: string): string {
  const s = sessions.find((s) => s.id === sessionId);
  return s ? s.title : sessionId.substring(0, 12) + "...";
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function DelegationTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [tasks, setTasks] = useState<DelegationTask[]>([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 });
  const sessions = useProjectStore((s) => s.sessions);

  const loadTasks = useCallback(() => {
    const orch = getDelegationOrchestrator();
    const projectId = useProjectStore.getState().currentProject?.id || "";
    const allTasks = projectId
      ? Array.from(orch.getDelegationsBySource("")).concat(
          sessions.flatMap((s) => orch.getDelegationsByTarget(s.id)),
        )
      : [];

    const seen = new Set<string>();
    const unique = allTasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    const allFromMemory = sessions.flatMap((s) => [
      ...orch.getDelegationsBySource(s.id),
      ...orch.getDelegationsByTarget(s.id),
    ]);
    for (const t of allFromMemory) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        unique.push(t);
      }
    }

    unique.sort((a, b) => b.createdAt - a.createdAt);
    setTasks(unique);
    setStats(orch.getStats());
  }, [sessions]);

  useEffect(() => {
    loadTasks();
    const orch = getDelegationOrchestrator();
    const unsub = orch.onStateChange(() => loadTasks());
    const timer = setInterval(loadTasks, 1000);
    return () => { unsub(); clearInterval(timer); };
  }, [loadTasks]);

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Stats bar */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
        {[
          { label: zh ? "总计" : "Total", value: stats.total, color: "var(--accent)" },
          { label: zh ? "运行中" : "Running", value: stats.running, color: "var(--accent)" },
          { label: zh ? "已完成" : "Completed", value: stats.completed, color: "var(--success)" },
          { label: zh ? "失败" : "Failed", value: stats.failed, color: "var(--error)" },
          { label: zh ? "等待中" : "Pending", value: stats.pending, color: "var(--text-muted)" },
        ].map((s) => (
          <div key={s.label} style={{
            background: "var(--bg-tertiary)",
            borderRadius: "6px",
            padding: "8px 14px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            border: "1px solid var(--border-primary)",
          }}>
            <span style={{ fontSize: "var(--fs-xl)", fontWeight: 700, color: s.color }}>{s.value}</span>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary, #888)" }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Task list */}
      {tasks.length === 0 ? (
        <div style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--text-secondary, #888)",
          fontSize: "var(--fs-md)",
        }}>
          {zh ? "暂无委派任务。在对话中使用 " : "No delegation tasks. Use "}
          <code style={{ color: "var(--accent)" }}>delegate_to_session</code>
          {zh ? " 工具来委派任务到其他会话。" : " tool to delegate tasks."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {tasks.map((task) => {
            const config = STATUS_CONFIG[task.status];
            const StatusIcon = config.Icon;
            const sourceTitle = getSessionTitle(sessions, task.sourceSessionId);
            const targetTitle = getSessionTitle(sessions, task.targetSessionId);
            return (
              <div
                key={task.id}
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <Link2 size={14} style={{ color: "var(--text-secondary)" }} />
                  <StatusIcon size={14} style={{ color: config.color }} />
                  <span style={{
                    fontSize: "var(--fs-xs)",
                    fontWeight: 600,
                    color: config.color,
                    background: `${config.color}22`,
                    padding: "2px 8px",
                    borderRadius: "4px",
                  }}>
                    {zh ? config.label : config.labelEn}
                  </span>
                  <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-primary)" }}>{sourceTitle}</span>
                  <ArrowRight size={12} style={{ color: "var(--text-secondary, #888)" }} />
                  <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-primary)" }}>{targetTitle}</span>
                  <span style={{ marginLeft: "auto", fontSize: "var(--fs-xs)", color: "var(--text-muted, #555)" }}>
                    {formatTime(task.createdAt)}
                  </span>
                </div>
                <div style={{
                  fontSize: "var(--fs-sm)",
                  color: "var(--text-secondary, #aaa)",
                  padding: "6px 8px",
                  background: "var(--bg-secondary)",
                  borderRadius: "4px",
                  borderLeft: `3px solid ${config.color}`,
                }}>
                  {truncate(task.task, 200)}
                </div>
                {task.result && (
                  <div style={{
                    fontSize: "var(--fs-xs)",
                    color: "var(--text-secondary, #888)",
                    padding: "4px 8px",
                    background: "var(--bg-secondary)",
                    borderRadius: "4px",
                    maxHeight: "60px",
                    overflow: "hidden",
                  }}>
                    <span style={{ color: "var(--success)", fontWeight: 600 }}>{zh ? "结果: " : "Result: "}</span>
                    {truncate(task.result, 150)}
                  </div>
                )}
                {task.error && (
                  <div style={{ fontSize: "var(--fs-xs)", color: "var(--error)", padding: "4px 8px" }}>
                    <span style={{ fontWeight: 600 }}>{zh ? "错误: " : "Error: "}</span>
                    {task.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
