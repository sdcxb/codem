/**
 * DelegationPanel — 跨会话委派任务可视化面板
 *
 * 展示当前项目的所有委派任务：
 * - 任务列表：源会话 → 目标会话、状态、时间
 * - 状态统计：总数 / 运行中 / 已完成 / 失败
 * - 依赖图：文本方式展示会话间委派关系
 * - 实时刷新：通过 DelegationOrchestrator.onStateChange 监听
 *
 * 样式参考 UsageStats.tsx 的面板模式。
 */

import { useState, useEffect, useCallback } from "react";
import { getDelegationOrchestrator } from "../core/session";
import type { DelegationTask, DelegationState } from "../core/session";
import { useProjectStore } from "../core/store";

interface DelegationPanelProps {
  onClose: () => void;
}

const STATUS_CONFIG: Record<DelegationState, { label: string; color: string; icon: string }> = {
  pending: { label: "等待中", color: "#6b7280", icon: "⏳" },
  running: { label: "执行中", color: "#3b82f6", icon: "🔄" },
  completed: { label: "已完成", color: "#10b981", icon: "✅" },
  failed: { label: "已失败", color: "#ef4444", icon: "❌" },
  cancelled: { label: "已取消", color: "#f59e0b", icon: "🚫" },
};

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function getSessionTitle(sessions: any[], sessionId: string): string {
  const s = sessions.find((s) => s.id === sessionId);
  return s ? s.title : sessionId.substring(0, 12) + "...";
}

export function DelegationPanel({ onClose }: DelegationPanelProps) {
  const [tasks, setTasks] = useState<DelegationTask[]>([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 });
  const sessions = useProjectStore((s) => s.sessions);

  const loadTasks = useCallback(() => {
    const orch = getDelegationOrchestrator();
    // 获取当前项目的所有任务
    const projectId = useProjectStore.getState().currentProject?.id || "";
    const allTasks = projectId
      ? Array.from(orch.getDelegationsBySource("")).concat(
          // 也获取目标会话在本项目的任务
          sessions.flatMap((s) => orch.getDelegationsByTarget(s.id)),
        )
      : [];

    // 去重
    const seen = new Set<string>();
    const unique = allTasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // 也加上 orchestrator 内存中的所有任务
    const allFromMemory = Array.from(
      // getStats 返回的是全局统计，我们需要具体任务列表
      // 直接从 sessions 查询所有相关任务
      sessions.flatMap((s) => [
        ...orch.getDelegationsBySource(s.id),
        ...orch.getDelegationsByTarget(s.id),
      ]),
    );
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

    // 监听状态变更
    const orch = getDelegationOrchestrator();
    const unsub = orch.onStateChange(() => {
      loadTasks();
    });

    // 定时刷新（1秒，防止遗漏非 orchestrator 触发的变更）
    const timer = setInterval(loadTasks, 1000);

    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [loadTasks]);

  return (
    <div className="delegation-panel" style={{
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "640px",
      maxHeight: "80vh",
      background: "var(--bg-secondary, #1e1e2e)",
      borderRadius: "12px",
      border: "1px solid var(--border-color, #333344)",
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 1000,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: "inherit",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 20px",
        borderBottom: "1px solid var(--border-color, #333344)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "var(--fs-xl)" }}>🔗</span>
          <span style={{ fontSize: "var(--fs-lg)", fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
            跨会话委派任务
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary, #888)",
            cursor: "pointer",
            fontSize: "var(--fs-xl)",
            padding: "4px 8px",
          }}
        >
          ✕
        </button>
      </div>

      {/* Stats bar */}
      <div style={{
        display: "flex",
        gap: "12px",
        padding: "12px 20px",
        borderBottom: "1px solid var(--border-color, #333344)",
      }}>
        <StatBadge label="总计" value={stats.total} color="#6366f1" />
        <StatBadge label="运行中" value={stats.running} color="#3b82f6" />
        <StatBadge label="已完成" value={stats.completed} color="#10b981" />
        <StatBadge label="失败" value={stats.failed} color="#ef4444" />
        <StatBadge label="等待中" value={stats.pending} color="#6b7280" />
      </div>

      {/* Task list */}
      <div style={{
        flex: 1,
        overflow: "auto",
        padding: "8px 0",
      }}>
        {tasks.length === 0 ? (
          <div style={{
            padding: "40px 20px",
            textAlign: "center",
            color: "var(--text-secondary, #888)",
            fontSize: "var(--fs-md)",
          }}>
            暂无委派任务。
            <br />
            在对话中使用 <code style={{ color: "var(--accent, #7c3aed)" }}>delegate_to_session</code> 工具来委派任务到其他会话。
          </div>
        ) : (
          tasks.map((task) => {
            const config = STATUS_CONFIG[task.status];
            const sourceTitle = getSessionTitle(sessions, task.sourceSessionId);
            const targetTitle = getSessionTitle(sessions, task.targetSessionId);
            return (
              <div
                key={task.id}
                style={{
                  padding: "12px 20px",
                  borderBottom: "1px solid var(--border-color, #2a2a3a)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                {/* Status + sessions */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "var(--fs-md)" }}>{config.icon}</span>
                  <span style={{
                    fontSize: "var(--fs-sm)",
                    fontWeight: 600,
                    color: config.color,
                    background: `${config.color}22`,
                    padding: "2px 8px",
                    borderRadius: "4px",
                  }}>
                    {config.label}
                  </span>
                  <span style={{ fontSize: "var(--fs-base)", color: "var(--text-primary, #e0e0e0)" }}>
                    {sourceTitle}
                  </span>
                  <span style={{ color: "var(--text-secondary, #888)" }}>→</span>
                  <span style={{ fontSize: "var(--fs-base)", color: "var(--text-primary, #e0e0e0)" }}>
                    {targetTitle}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: "var(--fs-xs)", color: "var(--text-secondary, #666)" }}>
                    {formatTime(task.createdAt)}
                  </span>
                </div>
                {/* Task description */}
                <div style={{
                  fontSize: "var(--fs-base)",
                  color: "var(--text-secondary, #aaa)",
                  padding: "4px 8px",
                  background: "var(--bg-tertiary, #181828)",
                  borderRadius: "4px",
                  borderLeft: `3px solid ${config.color}`,
                }}>
                  {truncate(task.task, 200)}
                </div>
                {/* Result (if completed) */}
                {task.result && (
                  <div style={{
                    fontSize: "var(--fs-sm)",
                    color: "var(--text-secondary, #888)",
                    padding: "4px 8px",
                    background: "var(--bg-tertiary, #181828)",
                    borderRadius: "4px",
                    maxHeight: "60px",
                    overflow: "hidden",
                  }}>
                    <span style={{ color: "#10b981", fontWeight: 600 }}>结果: </span>
                    {truncate(task.result, 150)}
                  </div>
                )}
                {/* Error (if failed) */}
                {task.error && (
                  <div style={{
                    fontSize: "var(--fs-sm)",
                    color: "#ef4444",
                    padding: "4px 8px",
                  }}>
                    <span style={{ fontWeight: 600 }}>错误: </span>
                    {task.error}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: "8px 20px",
        borderTop: "1px solid var(--border-color, #333344)",
        fontSize: "var(--fs-xs)",
        color: "var(--text-secondary, #666)",
        textAlign: "center",
      }}>
        委派深度限制: 2 层 · 最大并发: 5 · 自动死锁检测
      </div>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "2px",
      padding: "4px 12px",
      borderRadius: "6px",
      background: `${color}11`,
    }}>
      <span style={{ fontSize: "var(--fs-xl)", fontWeight: 700, color }}>{value}</span>
      <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary, #888)" }}>{label}</span>
    </div>
  );
}
