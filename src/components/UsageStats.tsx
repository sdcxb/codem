import { useState, useEffect } from "react";
import { getCostTracker, type UsageRecord } from "../core/llm/cost-tracker";

interface UsageStatsProps {
  onClose: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}分${Math.floor((ms % 60000) / 1000)}秒`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN");
}

export function UsageStats({ onClose }: UsageStatsProps) {
  const [stats, setStats] = useState<ReturnType<typeof getCostTracker.prototype.getStats> | null>(null);
  const [costByModel, setCostByModel] = useState<Record<string, number>>({});
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "models" | "history" | "limits">("overview");
  const [limits, setLimits] = useState<ReturnType<typeof getCostTracker.prototype.getLimits> | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = () => {
    const tracker = getCostTracker();
    setStats(tracker.getStats());
    setCostByModel(tracker.getCostByModel());
    setLimits(tracker.getLimits());
    // Get last 50 records from the last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    setRecords(tracker.getRecordsInRange(sevenDaysAgo, Date.now()).slice(-50).reverse());
  };

  if (!stats) return null;

  const maxModelCost = Math.max(...Object.values(costByModel), 1);

  return (
    <div className="usage-stats">
      <div className="usage-stats-header">
        <div className="usage-stats-title">
          <span className="usage-stats-icon">📊</span>
          <span>用量统计</span>
        </div>
        <button className="usage-stats-close" onClick={onClose}>✕</button>
      </div>

      <div className="usage-tabs">
        {(["overview", "models", "history", "limits"] as const).map((tab) => (
          <button
            key={tab}
            className={`usage-tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "overview" ? "概览" : tab === "models" ? "模型" : tab === "history" ? "历史" : "限额"}
          </button>
        ))}
      </div>

      <div className="usage-content">
        {activeTab === "overview" && (
          <div className="usage-overview">
            <div className="usage-stat-card">
              <span className="usage-stat-label">总费用</span>
              <span className="usage-stat-value">${stats.totalCost.toFixed(4)}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">今日费用</span>
              <span className="usage-stat-value today">${stats.todayCost.toFixed(4)}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">总调用次数</span>
              <span className="usage-stat-value">{stats.totalRecords}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">总会话数</span>
              <span className="usage-stat-value">{stats.totalSessions}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">输入 Tokens</span>
              <span className="usage-stat-value">{stats.totalInputTokens.toLocaleString()}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">输出 Tokens</span>
              <span className="usage-stat-value">{stats.totalOutputTokens.toLocaleString()}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">平均耗时</span>
              <span className="usage-stat-value">{formatDuration(stats.averageDuration)}</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">平均费用</span>
              <span className="usage-stat-value">${stats.averageCostPerCall.toFixed(6)}</span>
            </div>
          </div>
        )}

        {activeTab === "models" && (
          <div className="usage-models">
            {Object.entries(costByModel).length === 0 && (
              <div className="usage-empty">暂无数据</div>
            )}
            {Object.entries(costByModel)
              .sort((a, b) => b[1] - a[1])
              .map(([model, cost]) => (
                <div key={model} className="usage-model-item">
                  <div className="usage-model-header">
                    <span className="usage-model-name">{model}</span>
                    <span className="usage-model-cost">${cost.toFixed(4)}</span>
                  </div>
                  <div className="usage-model-bar">
                    <div
                      className="usage-model-fill"
                      style={{ width: `${(cost / maxModelCost) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
          </div>
        )}

        {activeTab === "history" && (
          <div className="usage-history">
            {records.length === 0 && (
              <div className="usage-empty">暂无记录</div>
            )}
            {records.map((record) => (
              <div key={record.id} className={`usage-record ${record.success ? "" : "error"}`}>
                <div className="usage-record-header">
                  <span className="usage-record-model">{record.model}</span>
                  <span className="usage-record-cost">${record.cost.toFixed(6)}</span>
                </div>
                <div className="usage-record-meta">
                  <span>{formatTime(record.timestamp)}</span>
                  <span>{record.inputTokens}→{record.outputTokens} tokens</span>
                  <span>{formatDuration(record.duration)}</span>
                  {record.toolCalls > 0 && <span>🔧 {record.toolCalls}</span>}
                </div>
                {record.error && (
                  <div className="usage-record-error">{record.error}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === "limits" && limits && (
          <div className="usage-limits">
            <div style={{ marginBottom: 12, fontSize: 12, color: "var(--text-secondary)" }}>
              设置费用上限，超出限额时将在控制台输出告警日志。
            </div>

            {/* Per-session limit */}
            <div className="usage-stat-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="usage-stat-label">📋 每会话限额</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {stats.todayCost > 0 ? `今日已用 $${stats.todayCost.toFixed(4)}` : ""}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>$</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={limits.perSession ?? ""}
                  onChange={(e) => setLimits({ ...limits, perSession: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="不限"
                  style={{
                    flex: 1, padding: "6px 10px", fontSize: 13, borderRadius: 6,
                    border: "1px solid var(--border-primary)",
                    background: "var(--bg-tertiary)", color: "var(--text-primary)",
                  }}
                />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>USD</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>单次对话最高费用，默认 $5</div>
            </div>

            {/* Per-day limit */}
            <div className="usage-stat-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="usage-stat-label">📅 每日限额</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {stats.todayCost > 0 ? `今日已用 $${stats.todayCost.toFixed(4)}` : ""}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>$</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={limits.perDay ?? ""}
                  onChange={(e) => setLimits({ ...limits, perDay: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="不限"
                  style={{
                    flex: 1, padding: "6px 10px", fontSize: 13, borderRadius: 6,
                    border: "1px solid var(--border-primary)",
                    background: "var(--bg-tertiary)", color: "var(--text-primary)",
                  }}
                />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>USD</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>每天累计最高费用，默认 $20</div>
            </div>

            {/* Total limit */}
            <div className="usage-stat-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="usage-stat-label">∞ 总限额</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  已用 $${stats.totalCost.toFixed(4)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>$</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={limits.total ?? ""}
                  onChange={(e) => setLimits({ ...limits, total: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="不限"
                  style={{
                    flex: 1, padding: "6px 10px", fontSize: 13, borderRadius: 6,
                    border: "1px solid var(--border-primary)",
                    background: "var(--bg-tertiary)", color: "var(--text-primary)",
                  }}
                />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>USD</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>所有时间的总费用上限，不设则无限制</div>
            </div>

            {/* Usage progress bars */}
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              {limits.perSession && stats.todayCost > 0 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                    <span>每日用量</span>
                    <span>${stats.todayCost.toFixed(2)} / ${limits.perDay?.toFixed(2) ?? "∞"}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${limits.perDay ? Math.min(100, (stats.todayCost / limits.perDay) * 100) : 0}%`,
                      background: limits.perDay && stats.todayCost / limits.perDay > 0.8 ? "#e74c3c" : "var(--accent)",
                      transition: "width 0.3s ease",
                    }} />
                  </div>
                </div>
              )}
              {limits.total && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                    <span>总用量</span>
                    <span>${stats.totalCost.toFixed(2)} / ${limits.total.toFixed(2)}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.min(100, (stats.totalCost / limits.total) * 100)}%`,
                      background: stats.totalCost / limits.total > 0.8 ? "#e74c3c" : "var(--accent)",
                      transition: "width 0.3s ease",
                    }} />
                  </div>
                </div>
              )}
            </div>

            {/* Save button */}
            <button
              onClick={() => {
                const tracker = getCostTracker();
                tracker.setLimits(limits);
                setSavingLimits(true);
                setTimeout(() => setSavingLimits(false), 2000);
              }}
              style={{
                marginTop: 8, padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 500,
                border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff",
                cursor: "pointer",
              }}
            >
              {savingLimits ? "✅ 已保存" : "保存限额"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
