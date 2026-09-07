import { useState, useEffect, useCallback } from "react";
import { SubagentTask, SubagentStatus } from "../core/subagent/subagent";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import { useProjectStore } from "../core/store";
import { AgentTeamsService } from "../core/provider/agent-teams-service";
import { getLang } from "../core/i18n/lang";

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

/** 团队成员状态 → 颜色点（与 AgentTeamsPanel 一致） */
const MEMBER_DOT: Record<string, string> = {
  idle: "#10b981", working: "#f59e0b", absent: "#8b8b8b", removed: "#6b7280",
};
const MEMBER_LABEL: Record<string, string> = {
  idle: "空闲", working: "工作中", absent: "离线", removed: "已移除",
};

/**
 * AgentPanel — 智能体工作列表（个体 + 团队双维度）
 *
 * 个体维度：SubagentRuntime 的子 agent 任务平铺列表（点条目下钻 AgentDetail）。
 * 团队维度：当当前会话存在活动 agent-teams 团队时，列表首部渲染「当前团队」卡片
 * （成员=角色名 + 状态点），点成员即下钻该成员的个体执行详情——
 * 成员本身是 SubagentRuntime 的可续聊子 agent（id 同源），两种维度看同一批 agent。
 * 团队成员条目从平铺列表去重（避免与团队卡片重复展示）。
 */
export function AgentPanel({ agents, onClose, onSelectAgent }: AgentPanelProps) {
  const zh = getLang() === "zh";
  const AgentIcon = PanelIcons.agent;
  const CloseIcon = ActionIcons.close;
  const currentSession = useProjectStore((s) => s.currentSession);
  const [teamSnap, setTeamSnap] = useState<any | null>(null);

  const refreshTeam = useCallback(() => {
    if (!currentSession) { setTeamSnap(null); return; }
    try {
      const svc = AgentTeamsService.getInstance();
      const team = svc.activeTeamOf(currentSession.id);
      setTeamSnap(team ? svc.status(team.id) : null);
    } catch { setTeamSnap(null); }
  }, [currentSession]);

  useEffect(() => {
    refreshTeam();
    try {
      const unsub = AgentTeamsService.getInstance().subscribe(refreshTeam);
      return unsub;
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTeam]);

  // 团队成员（agent-teams）id 集合：从平铺列表去重
  const memberIds = new Set((teamSnap?.members || []).map((m: any) => m.id).filter(Boolean));
  const flatAgents = teamSnap && memberIds.size > 0
    ? agents.filter((a) => !memberIds.has(a.id))
    : agents;
  const runningCount = agents.filter((a) => a.status === "running").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <div className="agent-panel-title">
          <span className="agent-panel-icon"><AgentIcon size={20} /></span>
          <span>{zh ? "智能体与团队工作列表" : "Agents & Teams"}</span>
        </div>
        <button className="agent-panel-close" onClick={onClose}><CloseIcon size={18} /></button>
      </div>

      <div className="agent-panel-stats">
        <div className="agent-stat">
          <span className="agent-stat-value running">{runningCount}</span>
          <span className="agent-stat-label">{zh ? "运行中" : "Running"}</span>
        </div>
        <div className="agent-stat">
          <span className="agent-stat-value completed">{completedCount}</span>
          <span className="agent-stat-label">{zh ? "已完成" : "Done"}</span>
        </div>
        <div className="agent-stat">
          <span className="agent-stat-value total">{agents.length}</span>
          <span className="agent-stat-label">{zh ? "总计" : "Total"}</span>
        </div>
      </div>

      {/* 团队维度：当前会话的活动 agent-teams 团队 */}
      {teamSnap && (
        <div style={{ margin: "0 10px 6px", border: "1px solid var(--border-primary, rgba(0,0,0,.1))", borderRadius: 10, overflow: "hidden", background: "var(--bg-secondary, #232834)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--border-primary, rgba(0,0,0,.08))" }}>
            <span style={{ fontWeight: 700, fontSize: "var(--fs-sm)" }}>👥 {teamSnap.name}</span>
            <span style={{ marginLeft: "auto", fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
              {zh ? `成员 ${(teamSnap.members || []).length} · 任务 ${(teamSnap.tasks || []).length}` : `${(teamSnap.members || []).length} members · ${(teamSnap.tasks || []).length} tasks`}
            </span>
            <span
              style={{ fontSize: "var(--fs-xs)", color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
              onClick={() => {
                try { window.dispatchEvent(new CustomEvent("codem:open-task-center", { detail: { tab: "teams" } })); } catch { /* noop */ }
              }}
            >
              {zh ? "团队视图 →" : "Teams →"}
            </span>
          </div>
          {(teamSnap.members || []).length === 0 && (
            <div style={{ padding: 8, fontSize: "var(--fs-xs)", color: "var(--text-muted)", textAlign: "center" }}>
              {zh ? "暂无成员 — 请助手用 agent_teams_add_member 添加" : "No members yet"}
            </div>
          )}
          {(teamSnap.members || []).map((m: any) => {
            const dot = MEMBER_DOT[m.status] || "#888";
            const label = MEMBER_LABEL[m.status] || m.status;
            const hasTask = !!m.id && agents.some((a) => a.id === m.id); // 个体任务在运行时中存在才可下钻
            return (
              <div
                key={m.id || m.name}
                className="agent-item"
                style={{
                  cursor: hasTask ? "pointer" : "default",
                  opacity: hasTask ? 1 : 0.55,
                  padding: "7px 10px", borderBottom: "1px solid var(--border-primary, rgba(0,0,0,.06))",
                }}
                onClick={() => { if (hasTask) onSelectAgent(m.id); }}
                title={hasTask
                  ? (zh ? "查看该成员的个体执行详情" : "Open this member's individual task")
                  : (zh ? "成员未就绪（无个体任务可查看）" : "Member not ready (no individual task)")}
              >
                <div className="agent-item-header">
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, display: "inline-block" }} />
                  <span className="agent-item-name" style={{ fontWeight: 600 }}>{m.name}</span>
                  {m.role && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>{m.role}</span>}
                  <span className="agent-item-status" style={{ fontSize: "var(--fs-xs)", color: dot }}>
                    {label}{zh ? "（成员）" : " (member)"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 个体维度：子 agent 任务平铺列表（团队成员已在上面去重） */}
      <div className="agent-list">
        {flatAgents.length === 0 && (
          <div className="agent-empty">
            {teamSnap
              ? (zh ? "暂无其它智能体任务（团队成员见上方）" : "No other subagent tasks (team members above)")
              : (zh ? "暂无智能体任务" : "No subagent tasks")}
          </div>
        )}
        {flatAgents.map((agent) => (
          <div
            key={agent.id}
            className={`agent-item ${agent.status}`}
            onClick={() => onSelectAgent(agent.id)}
          >
            <div className="agent-item-header">
              <span className="agent-item-icon">{getAgentIcon(agent.agentId)}</span>
              <span className="agent-item-name">{agent.name || agent.agentId}</span>
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
