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
    <div
      className="perf-dashboard perf-dashboard-inline"
      style={{
        width: "100%", height: "100%",
        background: "var(--bg-primary, #1e1e2e)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={18} />
            <span style={{ fontSize: 16, fontWeight: 700 }}>{S.perf.title[lang]}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => { telemetry.flush(); refresh(); }} style={headerBtnStyle}>
              <RefreshCw size={14} />
              {S.perf.refresh[lang]}
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs + Controls */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 16px", borderBottom: "1px solid var(--border-color, #333)",
          flexShrink: 0, flexWrap: "wrap", gap: 8,
        }}>
          <div style={{ display: "flex", gap: 4 }}>
            <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")} icon={<BarChart3 size={14} />} label={S.perf.overview[lang]} />
            <TabButton active={activeTab === "sessions"} onClick={() => setActiveTab("sessions")} icon={<Clock size={14} />} label={S.perf.sessions[lang]} />
            <TabButton active={activeTab === "latency"} onClick={() => setActiveTab("latency")} icon={<Gauge size={14} />} label={S.perf.latency[lang]} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {activeTab === "overview" && (
              <select
                value={timeRange}
                onChange={e => setTimeRange(e.target.value as TimeRange)}
                style={selectStyle}
              >
                <option value="5min">{S.perf.last5Min[lang]}</option>
                <option value="30min">{S.perf.last30Min[lang]}</option>
                <option value="60min">{S.perf.last60Min[lang]}</option>
              </select>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              {S.perf.autoRefresh[lang]}
            </label>
            <button onClick={handleExportOTel} style={headerBtnStyle}>
              <Download size={12} />
              {S.perf.exportOTel[lang]}
            </button>
            <button onClick={() => setShowClearConfirm(true)} style={headerBtnStyle}>
              <Trash2 size={12} />
              {S.perf.clearAll[lang]}
            </button>
          </div>
        </div>

        {exportMsg && (
          <div style={{ padding: "4px 16px", fontSize: 12, color: "#22c55e" }}>{exportMsg}</div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          {overview.totalEvents === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "#6b7280" }}>
              <Activity size={48} style={{ opacity: 0.3, marginBottom: 8 }} />
              <div>{S.perf.noData[lang]}</div>
            </div>
          ) : activeTab === "overview" ? (
            <>
              {/* Stat Cards */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                <StatCard value={overview.totalEvents} label={S.perf.totalEvents[lang]} color="#3b82f6" />
                <StatCard value={overview.totalSessions} label={S.perf.totalSessions[lang]} color="#a855f7" />
                <StatCard value={overview.recentEventRate} suffix={S.perf.eventsPerMin[lang]} label={S.perf.recentRate[lang]} color="#22c55e" />
              </div>

              {/* Trend Chart */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 4 }}>
                  <Zap size={14} />
                  {S.perf.eventTrend[lang]}
                </div>
                <div style={{
                  display: "flex", alignItems: "flex-end", gap: 1,
                  height: 120, padding: "8px 0",
                  background: "var(--bg-secondary, #181825)",
                  borderRadius: 8, border: "1px solid var(--border-color, #333)",
                }}>
                  {timeSeries.map((bucket, i) => (
                    <div key={i} style={{
                      flex: 1, minWidth: 2,
                      height: `${(bucket.count / maxCount) * 100}%`,
                      minHeight: bucket.count > 0 ? 2 : 0,
                      background: bucket.count > 0 ? "linear-gradient(180deg, #3b82f6, #1e40af)" : "transparent",
                      borderRadius: "2px 2px 0 0",
                      margin: "0 0.5px",
                    }} title={`${formatTime(bucket.timestamp)}: ${bucket.count}`} />
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginTop: 4 }}>
                  <span>{formatTime(timeSeries[0]?.timestamp || 0)}</span>
                  <span>{formatTime(timeSeries[timeSeries.length - 1]?.timestamp || 0)}</span>
                </div>
              </div>

              {/* Events by Type */}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  {S.perf.eventsByType[lang]}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {overview.eventsByType.map(evt => {
                    const pct = (evt.count / overview.totalEvents) * 100;
                    return (
                      <div key={evt.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{ minWidth: 200, fontFamily: "'Cascadia Code', monospace" }}>{evt.name}</span>
                        <div style={{ flex: 1, height: 16, background: "var(--bg-secondary, #181825)", borderRadius: 4, overflow: "hidden" }}>
                          <div style={{
                            width: `${pct}%`, height: "100%",
                            background: "linear-gradient(90deg, #3b82f6, #1e40af)",
                            borderRadius: 4,
                          }} />
                        </div>
                        <span style={{ minWidth: 60, textAlign: "right", color: "#6b7280" }}>{evt.count}</span>
                        <span style={{ minWidth: 50, textAlign: "right", color: "#6b7280" }}>{pct.toFixed(1)}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : activeTab === "sessions" ? (
            <>
              {/* Session Stats Table */}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{S.perf.sessionId[lang]}</th>
                    <th style={thStyle}>{S.perf.eventCount[lang]}</th>
                    <th style={thStyle}>{S.perf.duration[lang]}</th>
                    <th style={thStyle}>{S.perf.firstEvent[lang]}</th>
                    <th style={thStyle}>{S.perf.lastEvent[lang]}</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionStats.map(s => (
                    <tr key={s.sessionId}>
                      <td style={tdStyle}>{s.sessionId.slice(0, 20)}...</td>
                      <td style={tdStyle}>{s.eventCount}</td>
                      <td style={tdStyle}>{formatDuration(s.duration)}</td>
                      <td style={tdStyle}>{formatTime(s.firstEventAt)}</td>
                      <td style={tdStyle}>{formatTime(s.lastEventAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>
              {/* Latency Stats */}
              {latencyStats.length === 0 ? (
                <div style={{ textAlign: "center", padding: 24, color: "#6b7280" }}>
                  {S.perf.noData[lang]} — {lang === "zh" ? "需要事件 data 中包含 duration_ms 字段" : "Requires duration_ms field in event data"}
                </div>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{S.perf.eventName[lang]}</th>
                      <th style={thStyle}>{S.perf.count[lang]}</th>
                      <th style={thStyle}>{S.perf.avgMs[lang]}</th>
                      <th style={thStyle}>{S.perf.minMs[lang]}</th>
                      <th style={thStyle}>{S.perf.maxMs[lang]}</th>
                      <th style={thStyle}>{S.perf.p50Ms[lang]}</th>
                      <th style={thStyle}>{S.perf.p95Ms[lang]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latencyStats.map(l => (
                      <tr key={l.eventName}>
                        <td style={tdStyle}>{l.eventName}</td>
                        <td style={tdStyle}>{l.count}</td>
                        <td style={tdStyle}>{l.avgMs}</td>
                        <td style={tdStyle}>{l.minMs}</td>
                        <td style={tdStyle}>{l.maxMs}</td>
                        <td style={tdStyle}>{l.p50Ms}</td>
                        <td style={tdStyle}>{l.p95Ms}</td>
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
          <div style={{
            position: "absolute", inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 10,
          }} onClick={() => setShowClearConfirm(false)}>
            <div style={{
              background: "var(--bg-primary, #1e1e2e)",
              border: "1px solid var(--border-color, #333)",
              borderRadius: 12, padding: 24, maxWidth: 360,
              textAlign: "center",
            }} onClick={e => e.stopPropagation()}>
              <Trash2 size={32} style={{ color: "#ef4444", marginBottom: 8 }} />
              <div style={{ marginBottom: 16, fontSize: 14 }}>{S.perf.clearConfirm[lang]}</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button onClick={() => setShowClearConfirm(false)} style={dialogBtnStyle}>
                  {S.perf.clearAll[lang].includes("清") ? "取消" : "Cancel"}
                </button>
                <button onClick={handleClearAll} style={{ ...dialogBtnStyle, background: "#ef4444", color: "#fff", border: "none" }}>
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
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "4px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer",
        border: active ? "1px solid var(--accent, #7c3aed)" : "1px solid var(--border-color, #333)",
        background: active ? "var(--accent-soft, rgba(124,58,237,0.15))" : "transparent",
        color: "inherit", fontWeight: active ? 600 : 400,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function StatCard({ value, label, color, suffix }: { value: number; label: string; color: string; suffix?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "12px 20px", borderRadius: 8,
      border: `1px solid ${color}40`,
      background: `${color}10`,
      minWidth: 120,
    }}>
      <span style={{ fontSize: 24, fontWeight: 700, color }}>
        {value}{suffix ? <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 4 }}>{suffix}</span> : null}
      </span>
      <span style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{label}</span>
    </div>
  );
}

// ========== Styles ==========

const headerBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "3px 8px", borderRadius: 4, fontSize: 12, cursor: "pointer",
  border: "1px solid var(--border-color, #333)", background: "transparent", color: "inherit",
};

const selectStyle: React.CSSProperties = {
  padding: "3px 8px", borderRadius: 4, fontSize: 12,
  background: "var(--bg-secondary, #181825)",
  border: "1px solid var(--border-color, #333)",
  color: "inherit", cursor: "pointer",
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", fontSize: 12,
};

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "8px 6px",
  borderBottom: "1px solid var(--border-color, #333)",
  fontWeight: 600, fontSize: 11, color: "#6b7280",
  textTransform: "uppercase",
};

const tdStyle: React.CSSProperties = {
  padding: "6px", borderBottom: "1px solid var(--border-color, #222)",
  fontFamily: "'Cascadia Code', 'Fira Code', monospace",
};

const dialogBtnStyle: React.CSSProperties = {
  padding: "6px 16px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  border: "1px solid var(--border-color, #333)", background: "transparent", color: "inherit",
};
