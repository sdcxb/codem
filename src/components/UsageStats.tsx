import { useState, useEffect, useMemo } from "react";
import { getCostTracker, type UsageRecord } from "../core/llm/cost-tracker";
import { formatCacheHitPercent } from "../core/llm/cache-percent";
import { TokenActivityGrid, UsageChart } from "./UsageVisuals";
import { Activity, BarChart3, Wrench, ClipboardList, Calendar, CheckCircle, Infinity as InfinityIcon } from "lucide-react";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import { ConversationOverview } from "./ConversationOverview";
import { useProjectStore } from "../core/store";

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
  const CloseIcon = ActionIcons.close;
  const UsageIcon = PanelIcons.usage;
  const { currentSession } = useProjectStore();
  const [stats, setStats] = useState<ReturnType<typeof getCostTracker.prototype.getStats> | null>(null);
  const [costByModel, setCostByModel] = useState<Record<string, number>>({});
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "models" | "history" | "limits">("overview");
  const [limits, setLimits] = useState<ReturnType<typeof getCostTracker.prototype.getLimits> | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);
  const [vizRecords, setVizRecords] = useState<UsageRecord[]>([]);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = () => {
    const tracker = getCostTracker();
    setStats(tracker.getStats());
    setCostByModel(tracker.getCostByModel());
    setLimits(tracker.getLimits());
    // Get last 50 records from the last 7 days for history tab
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    setRecords(tracker.getRecordsInRange(sevenDaysAgo, Date.now()).slice(-50).reverse());
    // Get 28 days of records for visualizations
    const twentyEightDaysAgo = Date.now() - 28 * 24 * 60 * 60 * 1000;
    setVizRecords(tracker.getRecordsInRange(twentyEightDaysAgo, Date.now()));
  };

  // 缓存命中聚合（近 7 天 50 条内 provider 上报了 cache 的调用；未上报不显示）
  const cacheAgg = useMemo(() => {
    const reportable = records.filter(
      (r) => typeof r.cacheReadTokens === "number" && r.inputTokens > 0,
    );
    if (reportable.length === 0) return null;
    const hit = reportable.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);
    const input = reportable.reduce((s, r) => s + r.inputTokens, 0);
    const pct = formatCacheHitPercent(hit, input, 1);
    if (pct === null) return null;
    return { pct, hit, input, calls: reportable.length };
  }, [records]);

  if (!stats) return null;

  const maxModelCost = Math.max(...Object.values(costByModel), 1);

  return (
    <div className="usage-stats">
      <div className="usage-stats-header">
        <div className="usage-stats-title">
          <span className="usage-stats-icon"><UsageIcon size={16} /></span>
          <span>用量统计</span>
        </div>
        <button className="usage-stats-close" onClick={onClose}><CloseIcon size={16} /></button>
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
            {/* Conversation Overview */}
            <div className="usage-viz-section">
              <div className="usage-viz-section-header">
                <span className="usage-viz-section-title"><UsageIcon size={14} /> 对话概览</span>
              </div>
              <ConversationOverview sessionId={currentSession?.id} showCostBar={true} />
            </div>

            {/* Stat cards */}
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
            {cacheAgg && (
              <div className="usage-stat-card" title={`缓存读 ${cacheAgg.hit.toLocaleString()} / 输入 ${cacheAgg.input.toLocaleString()}（近 7 天 ${cacheAgg.calls} 次上报调用）`}>
                <span className="usage-stat-label">缓存命中率</span>
                <span className="usage-stat-value is-success">{cacheAgg.pct}%</span>
              </div>
            )}
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

            {/* Token Activity Heatmap */}
            <div className="usage-viz-section">
              <div className="usage-viz-section-header">
                <Activity size={14} />
                <span>Token 活跃度（近 28 天）</span>
              </div>
              <TokenActivityGrid records={vizRecords} days={28} />
            </div>

            {/* Daily Usage Chart */}
            <div className="usage-viz-section">
              <div className="usage-viz-section-header">
                <UsageIcon size={14} />
                <span>每日用量趋势（近 7 天）</span>
              </div>
              <UsageChart records={vizRecords} days={7} />
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
                  {record.toolCalls > 0 && <span className="usage-record-tools"><Wrench size={12} /> {record.toolCalls}</span>}
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
            <div className="usage-limits-hint">
              设置费用上限，超出限额时将在控制台输出告警日志。
            </div>

            {/* Per-session limit */}
            <div className="usage-stat-card usage-stat-card--limit">
              <div className="usage-limit-row">
                <span className="usage-stat-label usage-limit-label"><ClipboardList size={16} /> 每会话限额</span>
                <span className="usage-limit-used">
                  {stats.todayCost > 0 ? `今日已用 $${stats.todayCost.toFixed(4)}` : ""}
                </span>
              </div>
              <div className="usage-limit-input-row">
                <span className="usage-limit-currency">$</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={limits.perSession ?? ""}
                  onChange={(e) => setLimits({ ...limits, perSession: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="不限"
                  className="usage-limit-input"
                />
                <span className="usage-limit-unit">USD</span>
              </div>
              <div className="usage-limit-note">单次对话最高费用，默认 $5</div>
            </div>

            {/* Per-day limit */}
            <div className="usage-stat-card usage-stat-card--limit">
              <div className="usage-limit-row">
                <span className="usage-stat-label usage-limit-label"><Calendar size={16} /> 每日限额</span>
                <span className="usage-limit-used">
                  {stats.todayCost > 0 ? `今日已用 $${stats.todayCost.toFixed(4)}` : ""}
                </span>
              </div>
              <div className="usage-limit-input-row">
                <span className="usage-limit-currency">$</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={limits.perDay ?? ""}
                  onChange={(e) => setLimits({ ...limits, perDay: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="不限"
                  className="usage-limit-input"
                />
                <span className="usage-limit-unit">USD</span>
              </div>
              <div className="usage-limit-note">每天累计最高费用，默认 $20</div>
            </div>

            {/* Total limit */}
            <div className="usage-stat-card usage-stat-card--limit">
              <div className="usage-limit-row">
                <span className="usage-stat-label usage-limit-label"><InfinityIcon size={16} /> 总限额</span>
                <span className="usage-limit-used">
                  已用 $${stats.totalCost.toFixed(4)}
                </span>
              </div>
              <div className="usage-limit-input-row">
                <span className="usage-limit-currency">$</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={limits.total ?? ""}
                  onChange={(e) => setLimits({ ...limits, total: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="不限"
                  className="usage-limit-input"
                />
                <span className="usage-limit-unit">USD</span>
              </div>
              <div className="usage-limit-note">所有时间的总费用上限，不设则无限制</div>
            </div>

            {/* Usage progress bars */}
            <div className="usage-progress-block">
              {limits.perSession && stats.todayCost > 0 && (
                <div>
                  <div className="usage-progress-head">
                    <span>每日用量</span>
                    <span>${stats.todayCost.toFixed(2)} / ${limits.perDay?.toFixed(2) ?? "∞"}</span>
                  </div>
                  <div className="usage-progress-track">
                    <div
                      className={`usage-progress-fill${limits.perDay && stats.todayCost / limits.perDay > 0.8 ? " is-over" : ""}`}
                      style={{ width: `${limits.perDay ? Math.min(100, (stats.todayCost / limits.perDay) * 100) : 0}%` }}
                    />
                  </div>
                </div>
              )}
              {limits.total && (
                <div>
                  <div className="usage-progress-head">
                    <span>总用量</span>
                    <span>${stats.totalCost.toFixed(2)} / ${limits.total.toFixed(2)}</span>
                  </div>
                  <div className="usage-progress-track">
                    <div
                      className={`usage-progress-fill${stats.totalCost / limits.total > 0.8 ? " is-over" : ""}`}
                      style={{ width: `${Math.min(100, (stats.totalCost / limits.total) * 100)}%` }}
                    />
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
              className="usage-save-btn"
            >
              {savingLimits ? <span className="usage-saved"><CheckCircle size={16} /> 已保存</span> : "保存限额"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
