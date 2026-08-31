/**
 * ConversationOverview — 对话概览组件
 *
 * 在右侧栏或用量统计面板中展示当前会话的统计摘要。
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 *
 * 样式参考 codem-ui.css 第 22 节 .conversation-overview。
 */

import { memo, useMemo } from "react";
import { useAppStore, type Message } from "../store";
import { getCostTracker } from "../core/llm/cost-tracker";
import { useLang } from "../core/i18n/lang";
import { MessageSquare, Coins, Zap, Clock, Wrench } from "lucide-react";

interface ConversationOverviewProps {
  /** 可选：指定会话 ID，默认使用当前消息列表推断 */
  sessionId?: string;
  /** 是否显示费用进度条 */
  showCostBar?: boolean;
}

export const ConversationOverview = memo(function ConversationOverview({
  sessionId,
  showCostBar = true,
}: ConversationOverviewProps) {
  const lang = useLang();
  const messages = useAppStore((s) => s.messages);

  const stats = useMemo(() => {
    const userMsgs = messages.filter((m) => m.role === "user");
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const totalToolCalls = messages.reduce(
      (sum, m) => sum + (m.toolCalls?.length || 0),
      0
    );

    // 估算 token 数（粗略：按字符数 / 4）
    const totalChars = messages.reduce(
      (sum, m) => sum + (m.content?.length || 0),
      0
    );
    const estTokens = Math.round(totalChars / 4);

    // 时间跨度
    const firstTs = messages[0]?.timestamp;
    const lastTs = messages[messages.length - 1]?.timestamp;
    const durationMs =
      firstTs && lastTs ? lastTs - firstTs : 0;

    // 从 CostTracker 获取费用
    let cost = 0;
    if (sessionId) {
      const tracker = getCostTracker();
      const sessionCost = tracker.getSessionCost(sessionId);
      if (sessionCost) cost = sessionCost.totalCost;
    }

    return {
      userCount: userMsgs.length,
      assistantCount: assistantMsgs.length,
      totalMessages: messages.length,
      toolCalls: totalToolCalls,
      estTokens,
      durationMs,
      cost,
    };
  }, [messages, sessionId]);

  const limits = useMemo(() => {
    const tracker = getCostTracker();
    return tracker.getLimits();
  }, []);

  const costRatio = limits.perSession
    ? Math.min(100, (stats.cost / limits.perSession) * 100)
    : 0;

  const isCostWarning = limits.perSession
    ? stats.cost / limits.perSession > 0.8
    : false;

  return (
    <div className="conversation-overview">
      <div className="conversation-overview-header">
        <span className="conversation-overview-title">对话概览</span>
      </div>

      <div className="conversation-overview-stats">
        <div className="conversation-overview-stat">
          <MessageSquare size={16} style={{ color: "var(--accent)", marginBottom: 4 }} />
          <span className="conversation-overview-stat-value">{stats.totalMessages}</span>
          <span className="conversation-overview-stat-label">消息</span>
        </div>
        <div className="conversation-overview-stat">
          <Zap size={16} style={{ color: "var(--warning)", marginBottom: 4 }} />
          <span className="conversation-overview-stat-value">{stats.toolCalls}</span>
          <span className="conversation-overview-stat-label">工具调用</span>
        </div>
        <div className="conversation-overview-stat">
          <Coins size={16} style={{ color: "var(--success)", marginBottom: 4 }} />
          <span className="conversation-overview-stat-value">
            {stats.estTokens >= 1000
              ? `${(stats.estTokens / 1000).toFixed(1)}k`
              : stats.estTokens}
          </span>
          <span className="conversation-overview-stat-label">Tokens</span>
        </div>
      </div>

      {showCostBar && limits.perSession && (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 'var(--fs-sm)',
              marginBottom: 4,
              color: "var(--text-muted)",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Clock size={12} />
              {formatDuration(stats.durationMs)}
            </span>
            <span style={{ color: isCostWarning ? "var(--error)" : "var(--text-muted)" }}>
              ${stats.cost.toFixed(4)} / ${limits.perSession.toFixed(2)}
            </span>
          </div>
          <div className="conversation-overview-bar">
            <div
              className="conversation-overview-bar-fill"
              style={{
                width: `${costRatio}%`,
                background: isCostWarning ? "var(--error)" : "var(--accent)",
              }}
            />
          </div>
        </div>
      )}

      {!showCostBar && stats.durationMs > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 'var(--fs-sm)',
            color: "var(--text-muted)",
          }}
        >
          <Clock size={12} />
          {formatDuration(stats.durationMs)}
        </div>
      )}
      {/* P2 #28: Round grouping — show conversation rounds */}
      {stats.userCount > 0 && (
        <div className="conversation-overview-rounds">
          <div className="conversation-overview-rounds-header">
            {lang === "zh" ? "对话轮次" : "Conversation Rounds"}
          </div>
          {messages
            .reduce((rounds: Message[][], msg) => {
              if (msg.role === "user") {
                rounds.push([msg]);
              } else if (rounds.length > 0) {
                rounds[rounds.length - 1].push(msg);
              }
              return rounds;
            }, [])
            .slice(0, 10)
            .map((round, idx) => {
              const userMsg = round.find(m => m.role === "user");
              const preview = userMsg?.content?.substring(0, 40) || `Round ${idx + 1}`;
              const toolCount = round.reduce((s, m) => s + (m.toolCalls?.length || 0), 0);
              return (
                <div key={idx} className="conversation-overview-round-item" title={preview}>
                  <span className="conversation-overview-round-num">#{idx + 1}</span>
                  <span className="conversation-overview-round-preview">{preview}{preview.length >= 40 ? "..." : ""}</span>
                  {toolCount > 0 && <span className="conversation-overview-round-tools">{toolCount} <Wrench size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /></span>}
                </div>
              );
            })}
          {stats.userCount > 10 && (
            <div className="conversation-overview-rounds-more">+{stats.userCount - 10} {lang === "zh" ? "更多" : "more"}</div>
          )}
        </div>
      )}
    </div>
  );
});

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
