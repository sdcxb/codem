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
  const [activeTab, setActiveTab] = useState<"overview" | "models" | "history">("overview");

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = () => {
    const tracker = getCostTracker();
    setStats(tracker.getStats());
    setCostByModel(tracker.getCostByModel());
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
        {(["overview", "models", "history"] as const).map((tab) => (
          <button
            key={tab}
            className={`usage-tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "overview" ? "概览" : tab === "models" ? "模型" : "历史"}
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
      </div>
    </div>
  );
}
