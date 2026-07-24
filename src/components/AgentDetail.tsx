import { useState, useEffect, useRef } from "react";
import { SubagentTask, SubagentActivity } from "../core/subagent/subagent";
import { getLang } from "../core/i18n/lang";

interface AgentDetailProps {
  task: SubagentTask;
  onBack: () => void;
}

function getAgentIcon(agentId: string): string {
  switch (agentId) {
    case "build": return "🔧";
    case "explore": return "🔍";
    case "general": return "🤖";
    default: return "📌";
  }
}

/** Format duration in ms to a compact human-readable string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Format a timestamp to HH:MM:SS */
function formatTime(timestamp?: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString("zh-CN");
}

export function AgentDetail({ task, onBack }: AgentDetailProps) {
  const lang = getLang();
  const zh = lang === "zh";

  // Live ticker for elapsed time — requestAnimationFrame for smooth updates
  const elapsedRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (task.status !== "running" || !task.startedAt) return;
    let rafId: number;
    const update = () => {
      if (elapsedRef.current) {
        const el = (task.completedAt || Date.now()) - (task.startedAt || task.createdAt);
        elapsedRef.current.textContent = formatDuration(el);
      }
      rafId = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(rafId);
  }, [task.status, task.startedAt, task.completedAt, task.createdAt]);

  // Compute elapsed time
  const isRunning = task.status === "running";
  const elapsed = (task.completedAt || Date.now()) - (task.startedAt || task.createdAt);
  const elapsedStr = formatDuration(elapsed);

  const activities = task.activities || [];

  return (
    <div className="agent-detail">
      {/* Header */}
      <div className="agent-detail-header">
        <button className="agent-detail-back" onClick={onBack}>
          ← {zh ? "返回" : "Back"}
        </button>
        <div className="agent-detail-title">
          <span className="agent-detail-icon">{getAgentIcon(task.agentId)}</span>
          <span>{task.name || task.agentId}</span>
        </div>
        <span className={`agent-detail-status ${task.status}`}>
          {isRunning ? (zh ? "运行中" : "Running") :
           task.status === "completed" ? (zh ? "已完成" : "Completed") :
           task.status === "failed" ? (zh ? "失败" : "Failed") :
           task.status === "cancelled" ? (zh ? "已取消" : "Cancelled") :
           (zh ? "等待中" : "Pending")}
        </span>
      </div>

      <div className="agent-detail-body">
        {/* Elapsed Time */}
        <div className="subagent-elapsed-section">
          <div className="subagent-elapsed-label">
            {isRunning
              ? (zh ? "已处理" : "Processed")
              : (zh ? "总用时" : "Total time")}
          </div>
          <div className="subagent-elapsed-time">
            {isRunning && (
              <span className="subagent-elapsed-spinner" />
            )}
            <span ref={isRunning ? elapsedRef : undefined}>{elapsedStr}</span>
          </div>
        </div>

        {/* Activity List */}
        <div className="subagent-activity-list">
          {activities.length === 0 && !isRunning && (
            <div className="subagent-activity-empty">
              {zh ? "暂无活动记录" : "No activities recorded"}
            </div>
          )}
          {activities.length === 0 && isRunning && (
            <div className="subagent-activity-item running">
              <span className="subagent-activity-icon">
                <span className="subagent-activity-spinner" />
              </span>
              <span className="subagent-activity-label">
                {zh ? "正在准备..." : "Preparing..."}
              </span>
            </div>
          )}
          {activities.map((act, idx) => (
            <ActivityRow key={act.id} activity={act} zh={zh} />
          ))}
        </div>

        {/* Prompt */}
        <div className="agent-detail-section">
          <h4>{zh ? "任务指令" : "Task Prompt"}</h4>
          <pre className="agent-detail-prompt">{task.prompt}</pre>
        </div>

        {/* Result */}
        {task.result && (
          <div className="agent-detail-section">
            <h4>{zh ? "执行结果" : "Result"}</h4>
            <div className={`agent-result ${task.result.status}`}>
              <div className="agent-result-status">
                {zh ? "状态" : "Status"}: {task.result.status}
              </div>
              <div className="agent-result-summary">
                {task.result.summary}
              </div>
            </div>

            {task.result.filesTouched.length > 0 && (
              <div className="agent-result-files">
                <h5>{zh ? "修改的文件" : "Files Touched"}</h5>
                <ul>
                  {task.result.filesTouched.map((file, i) => (
                    <li key={i} className="mono">{file}</li>
                  ))}
                </ul>
              </div>
            )}

            {task.result.findings.length > 0 && (
              <div className="agent-result-findings">
                <h5>{zh ? "发现" : "Findings"}</h5>
                <ul>
                  {task.result.findings.map((finding, i) => (
                    <li key={i}>{finding}</li>
                  ))}
                </ul>
              </div>
            )}

            {task.result.output && (
              <div className="agent-result-output">
                <h5>{zh ? "详细输出" : "Detailed Output"}</h5>
                <pre>{task.result.output}</pre>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {task.error && (
          <div className="agent-detail-section error">
            <h4>{zh ? "错误信息" : "Error"}</h4>
            <pre className="agent-detail-error">{task.error}</pre>
          </div>
        )}

        {/* Meta info */}
        <div className="agent-detail-section">
          <h4>{zh ? "基本信息" : "Info"}</h4>
          <div className="agent-detail-grid">
            <div className="agent-detail-field">
              <label>{zh ? "工作目录" : "Working Dir"}</label>
              <span className="agent-detail-value mono">{task.cwd || "-"}</span>
            </div>
            <div className="agent-detail-field">
              <label>{zh ? "创建时间" : "Created"}</label>
              <span>{formatTime(task.createdAt)}</span>
            </div>
            {task.startedAt && (
              <div className="agent-detail-field">
                <label>{zh ? "开始时间" : "Started"}</label>
                <span>{formatTime(task.startedAt)}</span>
              </div>
            )}
            {task.completedAt && (
              <div className="agent-detail-field">
                <label>{zh ? "完成时间" : "Completed"}</label>
                <span>{formatTime(task.completedAt)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Single activity row */
function ActivityRow({ activity, zh }: { activity: SubagentActivity; zh: boolean }) {
  const isRunning = activity.status === "running";
  const duration = activity.completedAt
    ? activity.completedAt - activity.startedAt
    : Date.now() - activity.startedAt;

  return (
    <div className={`subagent-activity-item ${isRunning ? "running" : "done"}`}>
      <span className="subagent-activity-icon">
        {isRunning ? (
          <span className="subagent-activity-spinner" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6" fill="var(--success-bg, rgba(34,197,94,0.15))" stroke="var(--success, #22c55e)" strokeWidth="1.5" />
            <path d="M4 7l2 2 4-4" stroke="var(--success, #22c55e)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </span>
      <span className="subagent-activity-label">
        {isRunning
          ? (zh ? "正在" : "Running") + activity.label
          : (zh ? "已运行" : "Ran") + " " + activity.label}
      </span>
      <span className="subagent-activity-duration">
        {formatDuration(duration)}
      </span>
    </div>
  );
}
