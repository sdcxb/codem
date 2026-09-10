/**
 * P3-30: Performance Dashboard — 基于 Telemetry 的实时监控 UI
 *
 * 功能：
 * 1. 总览面板 — 事件总数、会话数、最近事件速率
 * 2. 事件趋势图 — 时间序列柱状图
 * 3. 会话级统计 — 每个 session 的事件数和持续时间
 * 4. 时延统计 — P50/P95/avg/min/max
 * 5. 按事件类型分组
 * 6. 自动刷新（10s）
 * 7. 清空遥测数据
 * 8. 导出 OTel JSON
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X, RefreshCw, Activity, Clock, Gauge, BarChart3,
  Trash2, Download, Zap,
} from "lucide-react";
import { useLang, S } from "../core/i18n/lang";
import { getTelemetry } from "../core/telemetry/telemetry";
import { getDatabase, persistDatabase } from "../core/storage";

interface PerformanceDashboardProps {
  onClose: () => void;
}

type TimeRange = "5min" | "30min" | "60min";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  "5min": 5 * 60 * 1000,
  "30min": 30 * 60 * 1000,
  "60min": 60 * 60 * 1000,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function formatTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

export function PerformanceDashboard({ onClose }: PerformanceDashboardProps) {
  const lang = useLang();
  const [activeTab, setActiveTab] = useState<"overview" | "sessions" | "latency">("overview");
  const [timeRange, setTimeRange] = useState<TimeRange>("30min");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [, setTick] = useState(0);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const telemetry = getTelemetry();

  const refresh = useCallback(() => {
    setTick(t => t + 1);
  }, []);

  // Auto refresh
  useEffect(() => {
    if (autoRefresh) {
      refreshTimer.current = setInterval(refresh, 10000);
      return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
    }
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, [autoRefresh, refresh]);

  const overview = telemetry.getOverviewStats();
  const timeSeries = telemetry.getTimeSeries(60_000, TIME_RANGE_MS[timeRange]);
  const sessionStats = telemetry.getSessionStats(20);
  const latencyStats = telemetry.getLatencyStats();

  const handleClearAll = useCallback(() => {
    try {
      const db = getDatabase();
      db.run("DELETE FROM telemetry_events");
      persistDatabase();
      setShowClearConfirm(false);
      refresh();
    } catch (err) {
      console.warn("[PerfDashboard] Clear failed:", err);
    }
  }, [refresh]);

  const handleExportOTel = useCallback(() => {
    // Export all sessions' OTel data
    const sessions = sessionStats;
    if (sessions.length === 0) {
      setExportMsg(S.perf.noData[lang]);
      setTimeout(() => setExportMsg(""), 2000);
      return;
    }
    // Export most recent session
    const latestSession = sessions[0];
    const otelJson = telemetry.exportOTel(latestSession.sessionId);
    navigator.clipboard.writeText(otelJson);
    setExportMsg(`${S.perf.exportCopied[lang]} (${latestSession.sessionId.slice(0, 12)}...)`);
    setTimeout(() => setExportMsg(""), 3000);
  }, [sessionStats, telemetry, lang]);

  // Compute max for trend chart scaling
  const maxCount = Math.max(1, ...timeSeries.map(b => b.count));
  const chartWidth = 100; // percentage
  const barWidth = chartWidth / Math.max(1, timeSeries.length);

  const panel = (
    <div className="perf-panel perf-panel-inline">
        {/* Header */}
        <div className="perf-header">
          <div className="perf-header-title">
            <Activity size={16} />
            <span className="perf-title">{S.perf.title[lang]}</span>
          </div>
          <div className="perf-header-actions">
            <button onClick={() => { telemetry.flush(); refresh(); }} className="perf-btn">
              <RefreshCw size={14} />
              {S.perf.refresh[lang]}
            </button>
          </div>
        </div>

        {/* Tabs + Controls */}
        <div className="perf-tabs">
          <div className="perf-tab-group">
            <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")} icon={<BarChart3 size={14} />} label={S.perf.overview[lang]} />
            <TabButton active={activeTab === "sessions"} onClick={() => setActiveTab("sessions")} icon={<Clock size={14} />} label={S.perf.sessions[lang]} />
            <TabButton active={activeTab === "latency"} onClick={() => setActiveTab("latency")} icon={<Gauge size={14} />} label={S.perf.latency[lang]} />
          </div>
          <div className="perf-controls">
            {activeTab === "overview" && (
              <select
                value={timeRange}
                onChange={e => setTimeRange(e.target.value as TimeRange)}
                className="perf-select"
              >
                <option value="5min">{S.perf.last5Min[lang]}</option>
                <option value="30min">{S.perf.last30Min[lang]}</option>
                <option value="60min">{S.perf.last60Min[lang]}</option>
              </select>
            )}
            <label className="perf-auto-refresh">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              {S.perf.autoRefresh[lang]}
            </label>
            <button onClick={handleExportOTel} className="perf-btn">
              <Download size={12} />
              {S.perf.exportOTel[lang]}
            </button>
            <button onClick={() => setShowClearConfirm(true)} className="perf-btn">
              <Trash2 size={12} />
              {S.perf.clearAll[lang]}
            </button>
          </div>
        </div>

        {exportMsg && (
          <div className="perf-msg">{exportMsg}</div>
        )}

        {/* Content */}
        <div className="perf-content">
          {overview.totalEvents === 0 ? (
            <div className="perf-empty">
              <Activity size={48} className="perf-empty-icon" />
              <div>{S.perf.noData[lang]}</div>
            </div>
          ) : activeTab === "overview" ? (
            <>
              {/* Stat Cards */}
              <div className="perf-stat-row">
                <StatCard value={overview.totalEvents} label={S.perf.totalEvents[lang]} color="var(--info)" />
                <StatCard value={overview.totalSessions} label={S.perf.totalSessions[lang]} color="var(--accent)" />
                <StatCard value={overview.recentEventRate} suffix={S.perf.eventsPerMin[lang]} label={S.perf.recentRate[lang]} color="var(--success)" />
              </div>

              {/* Trend Chart */}
              <div className="perf-section">
                <div className="perf-section-title">
                  <Zap size={14} />
                  {S.perf.eventTrend[lang]}
                </div>
                <div className="perf-chart">
                  {timeSeries.map((bucket, i) => (
                    <div key={i} className={`perf-chart-bar${bucket.count > 0 ? " has-value" : ""}`} style={{
                      height: `${(bucket.count / maxCount) * 100}%`,
                      minHeight: bucket.count > 0 ? 2 : 0,
                    }} title={`${formatTime(bucket.timestamp)}: ${bucket.count}`} />
                  ))}
                </div>
                <div className="perf-chart-axis">
                  <span>{formatTime(timeSeries[0]?.timestamp || 0)}</span>
                  <span>{formatTime(timeSeries[timeSeries.length - 1]?.timestamp || 0)}</span>
                </div>
              </div>

              {/* Events by Type */}
              <div>
                <div className="perf-section-title">
                  {S.perf.eventsByType[lang]}
                </div>
                <div className="perf-type-list">
                  {overview.eventsByType.map(evt => {
                    const pct = (evt.count / overview.totalEvents) * 100;
                    return (
                      <div key={evt.name} className="perf-type-row">
                        <span className="perf-type-name">{evt.name}</span>
                        <div className="perf-type-bar">
                          <div className="perf-type-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="perf-type-count">{evt.count}</span>
                        <span className="perf-type-pct">{pct.toFixed(1)}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : activeTab === "sessions" ? (
            <>
              {/* Session Stats Table */}
              <table className="perf-table">
                <thead>
                  <tr>
                    <th className="perf-th">{S.perf.sessionId[lang]}</th>
                    <th className="perf-th">{S.perf.eventCount[lang]}</th>
                    <th className="perf-th">{S.perf.duration[lang]}</th>
                    <th className="perf-th">{S.perf.firstEvent[lang]}</th>
                    <th className="perf-th">{S.perf.lastEvent[lang]}</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionStats.map(s => (
                    <tr key={s.sessionId}>
                      <td className="perf-td">{s.sessionId.slice(0, 20)}...</td>
                      <td className="perf-td">{s.eventCount}</td>
                      <td className="perf-td">{formatDuration(s.duration)}</td>
                      <td className="perf-td">{formatTime(s.firstEventAt)}</td>
                      <td className="perf-td">{formatTime(s.lastEventAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>
              {/* Latency Stats */}
              {latencyStats.length === 0 ? (
                <div className="perf-empty">
                  {S.perf.noData[lang]} — {lang === "zh" ? "需要事件 data 中包含 duration_ms 字段" : "Requires duration_ms field in event data"}
                </div>
              ) : (
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th className="perf-th">{S.perf.eventName[lang]}</th>
                      <th className="perf-th">{S.perf.count[lang]}</th>
                      <th className="perf-th">{S.perf.avgMs[lang]}</th>
                      <th className="perf-th">{S.perf.minMs[lang]}</th>
                      <th className="perf-th">{S.perf.maxMs[lang]}</th>
                      <th className="perf-th">{S.perf.p50Ms[lang]}</th>
                      <th className="perf-th">{S.perf.p95Ms[lang]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latencyStats.map(l => (
                      <tr key={l.eventName}>
                        <td className="perf-td">{l.eventName}</td>
                        <td className="perf-td">{l.count}</td>
                        <td className="perf-td">{l.avgMs}</td>
                        <td className="perf-td">{l.minMs}</td>
                        <td className="perf-td">{l.maxMs}</td>
                        <td className="perf-td">{l.p50Ms}</td>
                        <td className="perf-td">{l.p95Ms}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        {/* Clear confirmation dialog */}
        {showClearConfirm && (
          <div className="perf-dialog-overlay" onClick={() => setShowClearConfirm(false)}>
            <div className="perf-dialog" onClick={e => e.stopPropagation()}>
              <Trash2 size={32} className="perf-dialog-icon" />
              <div className="perf-dialog-text">{S.perf.clearConfirm[lang]}</div>
              <div className="perf-dialog-actions">
                <button onClick={() => setShowClearConfirm(false)} className="perf-dialog-btn">
                  {S.perf.clearAll[lang].includes("清") ? "取消" : "Cancel"}
                </button>
                <button onClick={handleClearAll} className="perf-dialog-btn is-danger">
                  {S.perf.clearAll[lang]}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
  );

  return panel;
}

// ========== Components ==========

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`perf-tab-btn${active ? " is-active" : ""}`}
    >
      {icon}
      {label}
    </button>
  );
}

function StatCard({ value, label, color, suffix }: { value: number; label: string; color: string; suffix?: string }) {
  return (
    <div className="perf-stat-card" style={{ color }}>
      <span className="perf-stat-value">
        {value}{suffix ? <span className="perf-stat-suffix">{suffix}</span> : null}
      </span>
      <span className="perf-stat-label">{label}</span>
    </div>
  );
}
