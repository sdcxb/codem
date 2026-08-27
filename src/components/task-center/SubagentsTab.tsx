/**
 * SubagentsTab — 子智能体 Tab
 *
 * 复用 AgentPanel 的核心逻辑，去掉外层弹窗框架。
 * 使用 lucide-react 图标，不用 emoji。
 * 数据由父组件 TaskCenter 从 App state 传入。
 */

import { CheckCircle2, Loader2, XCircle, Ban, Timer, Wrench, Search, Bot, FileText, Lightbulb, Pin } from "lucide-react";
import type { SubagentTask, SubagentStatus } from "../../core/subagent/subagent";
import { useLang } from "../../core/i18n/lang";

interface SubagentsTabProps {
  agents: SubagentTask[];
  onSelectAgent: (taskId: string) => void;
}

const STATUS_ICONS: Record<SubagentStatus, { Icon: typeof CheckCircle2; color: string }> = {
  running: { Icon: Loader2, color: "var(--accent)" },
  completed: { Icon: CheckCircle2, color: "var(--success)" },
  failed: { Icon: XCircle, color: "var(--error)" },
  cancelled: { Icon: Ban, color: "var(--warning)" },
  pending: { Icon: Timer, color: "var(--text-muted)" },
};

function getStatusLabel(status: SubagentStatus, zh: boolean): string {
  const labels: Record<SubagentStatus, { zh: string; en: string }> = {
    running: { zh: "运行中", en: "Running" },
    completed: { zh: "已完成", en: "Completed" },
    failed: { zh: "失败", en: "Failed" },
    cancelled: { zh: "已取消", en: "Cancelled" },
    pending: { zh: "等待中", en: "Pending" },
  };
  return zh ? labels[status]?.zh || status : labels[status]?.en || status;
}

const AGENT_ICONS: Record<string, typeof Wrench> = {
  build: Wrench,
  explore: Search,
  general: Bot,
  plan: FileText,
  verify: CheckCircle2,
};

function formatTime(timestamp: number, zh: boolean): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return zh ? `${Math.floor(diff / 1000)}秒前` : `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return zh ? `${Math.floor(diff / 60000)}分钟前` : `${Math.floor(diff / 60000)}m ago`;
  return zh ? `${Math.floor(diff / 3600000)}小时前` : `${Math.floor(diff / 3600000)}h ago`;
}

export function SubagentsTab({ agents, onSelectAgent }: SubagentsTabProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const runningCount = agents.filter((a) => a.status === "running").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;
  const failedCount = agents.filter((a) => a.status === "failed").length;

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Stats */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
        {[
{ label: zh ? "运行中" : "Running", value: runningCount, color: "var(--accent)" },
    { label: zh ? "已完成" : "Completed", value: completedCount, color: "var(--success)" },
    { label: zh ? "失败" : "Failed", value: failedCount, color: "var(--error)" },
    { label: zh ? "总计" : "Total", value: agents.length, color: "var(--accent)" },
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
            <span style={{ fontSize: "18px", fontWeight: 700, color: s.color }}>{s.value}</span>
            <span style={{ fontSize: "11px", color: "var(--text-secondary, #888)" }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Agent list */}
      {agents.length === 0 ? (
        <div style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--text-secondary, #888)",
          fontSize: "14px",
        }}>
          {zh ? "暂无子智能体任务。在对话中使用 " : "No sub-agent tasks. Use "}
          <code style={{ color: "var(--accent)" }}>subagent</code>
          {zh ? " 工具来创建子智能体。" : " tool to create sub-agents."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {agents.map((agent) => {
            const statusCfg = STATUS_ICONS[agent.status] || STATUS_ICONS.pending;
            const StatusIcon = statusCfg.Icon;
            const AgentIcon = AGENT_ICONS[agent.agentId] || Bot;
            return (
              <div
                key={agent.id}
                onClick={() => onSelectAgent(agent.id)}
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  transition: "border-color 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-primary)")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <AgentIcon size={14} style={{ color: "var(--text-secondary)" }} />
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    {agent.name || agent.agentId}
                  </span>
                  {agent.persistent && (
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 2,
                      fontSize: "9px",
                      padding: "1px 6px",
                      borderRadius: "3px",
                      background: "var(--accent)22",
                      color: "var(--accent)",
                    }}>
                      <Pin size={9} /> {zh ? "持久" : "persistent"}
                    </span>
                  )}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: "11px", color: statusCfg.color }}>
                    <StatusIcon size={12} /> {getStatusLabel(agent.status, zh)}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: "10px", color: "var(--text-muted, #555)" }}>
                    {formatTime(agent.createdAt, zh)}
                  </span>
                </div>
                <div style={{
                  fontSize: "12px",
                  color: "var(--text-secondary, #aaa)",
                  padding: "4px 8px",
                  background: "var(--bg-secondary)",
                  borderRadius: "4px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {agent.prompt}
                </div>
                {agent.result && (
                  <div style={{
                    fontSize: "11px",
                    color: "var(--text-secondary, #888)",
                    display: "flex",
                    gap: "12px",
                  }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <FileText size={11} /> {agent.result.filesTouched.length} {zh ? "个文件" : "files"}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <Lightbulb size={11} /> {agent.result.findings.length} {zh ? "个发现" : "findings"}
                    </span>
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
