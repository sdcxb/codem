import { SubagentTask } from "../core/subagent/subagent";

interface AgentDetailProps {
  task: SubagentTask;
  onBack: () => void;
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "running": return "🔄";
    case "completed": return "✅";
    case "failed": return "❌";
    case "cancelled": return "⏹️";
    case "pending": return "⏳";
    default: return "❓";
  }
}

function getAgentIcon(agentId: string): string {
  switch (agentId) {
    case "build": return "🔧";
    case "explore": return "🔍";
    case "general": return "🤖";
    default: return "📌";
  }
}

function formatDuration(start?: number, end?: number): string {
  if (!start) return "-";
  const duration = (end || Date.now()) - start;
  if (duration < 1000) return `${duration}ms`;
  if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
  return `${Math.floor(duration / 60000)}分${Math.floor((duration % 60000) / 1000)}秒`;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString("zh-CN");
}

export function AgentDetail({ task, onBack }: AgentDetailProps) {
  return (
    <div className="agent-detail">
      <div className="agent-detail-header">
        <button className="agent-detail-back" onClick={onBack}>
          ← 返回
        </button>
        <div className="agent-detail-title">
          <span className="agent-detail-icon">{getAgentIcon(task.agentId)}</span>
          <span>{task.agentId}</span>
        </div>
        <span className={`agent-detail-status ${task.status}`}>
          {getStatusIcon(task.status)} {task.status}
        </span>
      </div>

      <div className="agent-detail-body">
        {/* Basic Info */}
        <div className="agent-detail-section">
          <h4>基本信息</h4>
          <div className="agent-detail-grid">
            <div className="agent-detail-field">
              <label>任务 ID</label>
              <span className="agent-detail-value mono">{task.id}</span>
            </div>
            <div className="agent-detail-field">
              <label>父任务 ID</label>
              <span className="agent-detail-value mono">{task.parentId || "(主任务)"}</span>
            </div>
            <div className="agent-detail-field">
              <label>工作目录</label>
              <span className="agent-detail-value mono">{task.cwd || "-"}</span>
            </div>
            <div className="agent-detail-field">
              <label>运行时长</label>
              <span>{formatDuration(task.startedAt, task.completedAt)}</span>
            </div>
            <div className="agent-detail-field">
              <label>类型</label>
              <span>{task.persistent ? "🔒 持久协作" : "⚡ 临时任务"}</span>
            </div>
          </div>
        </div>

        {/* Prompt */}
        <div className="agent-detail-section">
          <h4>任务指令</h4>
          <pre className="agent-detail-prompt">{task.prompt}</pre>
        </div>

        {/* Timeline */}
        <div className="agent-detail-section">
          <h4>时间线</h4>
          <div className="agent-detail-timeline">
            <div className="timeline-item">
              <span className="timeline-dot created"></span>
              <span className="timeline-label">创建</span>
              <span className="timeline-time">{formatTime(task.createdAt)}</span>
            </div>
            {task.startedAt && (
              <div className="timeline-item">
                <span className="timeline-dot started"></span>
                <span className="timeline-label">开始</span>
                <span className="timeline-time">{formatTime(task.startedAt)}</span>
              </div>
            )}
            {task.completedAt && (
              <div className="timeline-item">
                <span className="timeline-dot completed"></span>
                <span className="timeline-label">完成</span>
                <span className="timeline-time">{formatTime(task.completedAt)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Result */}
        {task.result && (
          <div className="agent-detail-section">
            <h4>执行结果</h4>
            <div className={`agent-result ${task.result.status}`}>
              <div className="agent-result-status">
                状态: {task.result.status}
              </div>
              <div className="agent-result-summary">
                {task.result.summary}
              </div>
            </div>

            {task.result.filesTouched.length > 0 && (
              <div className="agent-result-files">
                <h5>修改的文件</h5>
                <ul>
                  {task.result.filesTouched.map((file, i) => (
                    <li key={i} className="mono">{file}</li>
                  ))}
                </ul>
              </div>
            )}

            {task.result.findings.length > 0 && (
              <div className="agent-result-findings">
                <h5>发现</h5>
                <ul>
                  {task.result.findings.map((finding, i) => (
                    <li key={i}>{finding}</li>
                  ))}
                </ul>
              </div>
            )}

            {task.result.output && (
              <div className="agent-result-output">
                <h5>详细输出</h5>
                <pre>{task.result.output}</pre>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {task.error && (
          <div className="agent-detail-section error">
            <h4>错误信息</h4>
            <pre className="agent-detail-error">{task.error}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
