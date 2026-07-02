import { SubagentTask, SubagentStatus } from "../core/subagent/subagent";

interface AgentPanelProps {
  agents: SubagentTask[];
  onClose: () => void;
  onSelectAgent: (taskId: string) => void;
}

function getStatusIcon(status: SubagentStatus): string {
  switch (status) {
    case "running": return "🔄";
    case "completed": return "✅";
    case "failed": return "❌";
    case "cancelled": return "⏹️";
    case "pending": return "⏳";
    default: return "❓";
  }
}

function getStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "running": return "运行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    case "pending": return "等待中";
    default: return "未知";
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

function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  return `${Math.floor(diff / 3600000)}小时前`;
}

export function AgentPanel({ agents, onClose, onSelectAgent }: AgentPanelProps) {
  const runningCount = agents.filter((a) => a.status === "running").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <div className="agent-panel-title">
          <span className="agent-panel-icon">🤖</span>
          <span>智能体工作列表</span>
        </div>
        <button className="agent-panel-close" onClick={onClose}>✕</button>
      </div>

      <div className="agent-panel-stats">
        <div className="agent-stat">
          <span className="agent-stat-value running">{runningCount}</span>
          <span className="agent-stat-label">运行中</span>
        </div>
        <div className="agent-stat">
          <span className="agent-stat-value completed">{completedCount}</span>
          <span className="agent-stat-label">已完成</span>
        </div>
        <div className="agent-stat">
          <span className="agent-stat-value total">{agents.length}</span>
          <span className="agent-stat-label">总计</span>
        </div>
      </div>

      <div className="agent-list">
        {agents.length === 0 && (
          <div className="agent-empty">暂无智能体任务</div>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`agent-item ${agent.status}`}
            onClick={() => onSelectAgent(agent.id)}
          >
            <div className="agent-item-header">
              <span className="agent-item-icon">{getAgentIcon(agent.agentId)}</span>
              <span className="agent-item-name">{agent.agentId}</span>
              {agent.persistent && <span className="agent-item-badge">持久</span>}
              <span className="agent-item-status">
                {getStatusIcon(agent.status)} {getStatusLabel(agent.status)}
              </span>
            </div>
            <div className="agent-item-prompt">{agent.prompt}</div>
            <div className="agent-item-meta">
              <span>{formatTime(agent.createdAt)}</span>
              {agent.result && (
                <span className="agent-item-files">
                  📁 {agent.result.filesTouched.length} 个文件
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
