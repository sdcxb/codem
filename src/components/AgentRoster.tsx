/**
 * AgentRoster — 多 Agent 协作面板
 *
 * 展示当前会话中活跃的智能体列表，包括：
 * - 主智能体状态
 * - 子智能体列表及其状态
 * - 每个智能体的角色、模型、进度
 * - 可展开查看智能体详情
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { useState, useEffect, memo, useCallback } from "react";
import { Bot, ChevronDown, ChevronRight, LoaderCircle, CheckCircle2, XCircle, Circle, Cpu, Wrench } from "lucide-react";
import { getSubagentManager, type SubagentTask } from "../core/subagent/subagent";

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: "idle" | "running" | "completed" | "failed";
  model?: string;
  summary?: string;
  startedAt?: number;
  toolCount?: number;
}

interface AgentRosterProps {
  /** 会话 ID（用于过滤子智能体） */
  sessionId?: string;
  /** 当前主智能体模型 */
  mainModel?: string;
  /** 是否正在运行 */
  isRunning?: boolean;
}

const STATUS_CONFIG = {
  idle: { icon: Circle, label: "待命", color: "idle" },
  running: { icon: LoaderCircle, label: "运行中", color: "running" },
  completed: { icon: CheckCircle2, label: "已完成", color: "completed" },
  failed: { icon: XCircle, label: "失败", color: "failed" },
};

export const AgentRoster = memo(function AgentRoster({
  sessionId,
  mainModel = "",
  isRunning = false,
}: AgentRosterProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  const refreshAgents = useCallback(() => {
    const manager = getSubagentManager();
    const tasks = manager.getAllTasks();
    const agentList: AgentInfo[] = [];

    // 主智能体
    agentList.push({
      id: "main",
      name: "主智能体",
      role: "orchestrator",
      status: isRunning ? "running" : "idle",
      model: mainModel,
    });

    // 子智能体
    for (const task of tasks) {
      agentList.push({
        id: task.id,
        name: task.name || task.agentId || "子智能体",
        role: task.agentId || "general",
        status: task.status === "running" ? "running"
          : task.status === "completed" ? "completed"
          : task.status === "failed" ? "failed"
          : "idle",
        summary: task.result?.summary,
        startedAt: task.startedAt,
        toolCount: task.activities?.length,
      });
    }

    setAgents(agentList);
  }, [sessionId, mainModel, isRunning]);

  useEffect(() => {
    refreshAgents();
    const timer = setInterval(refreshAgents, 2000);
    return () => clearInterval(timer);
  }, [refreshAgents]);

  const toggleAgent = useCallback((id: string) => {
    setExpandedAgent((prev) => (prev === id ? null : id));
  }, []);

  const runningCount = agents.filter((a) => a.status === "running").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;
  const failedCount = agents.filter((a) => a.status === "failed").length;

  return (
    <div className="agent-roster">
      <div className="agent-roster-header">
        <Bot size={14} />
        <span className="agent-roster-title">智能体</span>
        <span className="agent-roster-stats">
          {runningCount > 0 && <span className="stat-running">{runningCount} 运行中</span>}
          {completedCount > 0 && <span className="stat-completed">{completedCount} 完成</span>}
          {failedCount > 0 && <span className="stat-failed">{failedCount} 失败</span>}
        </span>
      </div>

      <div className="agent-roster-list">
        {agents.map((agent) => {
          const config = STATUS_CONFIG[agent.status];
          const StatusIcon = config.icon;
          const isExpanded = expandedAgent === agent.id;
          const hasDetail = Boolean(agent.summary || agent.toolCount);

          return (
            <div
              key={agent.id}
              className={`agent-roster-item status-${config.color} ${agent.id === "main" ? "is-main" : ""}`}
            >
              <div
                className={`agent-roster-item-header ${hasDetail ? "expandable" : ""}`}
                onClick={hasDetail ? () => toggleAgent(agent.id) : undefined}
              >
                {hasDetail && (
                  isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
                )}
                <StatusIcon
                  size={12}
                  className={agent.status === "running" ? "spinning" : ""}
                />
                <span className="agent-roster-item-name">{agent.name}</span>
                <span className="agent-roster-item-role">{agent.role}</span>
                {agent.model && (
                  <span className="agent-roster-item-model">
                    <Cpu size={10} />
                    {agent.model}
                  </span>
                )}
              </div>

              {isExpanded && hasDetail && (
                <div className="agent-roster-item-detail">
                  {agent.summary && (
                    <div className="agent-roster-detail-section">
                      <span className="agent-roster-detail-label">摘要</span>
                      <p>{agent.summary}</p>
                    </div>
                  )}
                  {agent.toolCount !== undefined && agent.toolCount > 0 && (
                    <div className="agent-roster-detail-section">
                      <span className="agent-roster-detail-label">
                        <Wrench size={10} />
                        工具调用: {agent.toolCount}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
