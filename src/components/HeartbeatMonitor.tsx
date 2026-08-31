import { useState, useEffect } from "react";
import {
  getHeartbeatManager,
  type HeartbeatConfig,
  type HeartbeatStatus,
  type HeartbeatData,
  type HeartbeatEvent,
} from "../core/heartbeat/heartbeat";
import { useLang } from "../core/i18n/lang";

const STATUS_COLORS: Record<HeartbeatStatus, string> = {
  active: "var(--success)",
  idle: "var(--info)",
  paused: "var(--warning)",
  stopped: "var(--text-muted)",
};

const STATUS_LABELS_ZH: Record<HeartbeatStatus, string> = {
  active: "活跃",
  idle: "空闲",
  paused: "已暂停",
  stopped: "已停止",
};

const STATUS_LABELS_EN: Record<HeartbeatStatus, string> = {
  active: "Active",
  idle: "Idle",
  paused: "Paused",
  stopped: "Stopped",
};

interface SessionHeartbeatInfo {
  sessionId: string;
  status: HeartbeatStatus;
  data: HeartbeatData;
}

export function HeartbeatMonitor() {
  const lang = useLang();
  const zh = lang === "zh";
  const [config, setConfig] = useState<HeartbeatConfig>(() => getHeartbeatManager().getGlobalConfig());
  const [stats, setStats] = useState(() => getHeartbeatManager().getStats());
  const [sessions, setSessions] = useState<SessionHeartbeatInfo[]>([]);
  const [events, setEvents] = useState<HeartbeatEvent[]>([]);
  const [saved, setSaved] = useState(false);

  const refresh = () => {
    const mgr = getHeartbeatManager();
    setStats(mgr.getStats());
    const all = mgr.getAll();
    const infos: SessionHeartbeatInfo[] = [];
    // getActive returns active ones, but we also want to show all
    // We can get all via the manager's internal map — but it's private.
    // Use getActive() for now and also check getStats for total.
    for (const hb of all) {
      infos.push({
        sessionId: hb.getData().sessionId,
        status: hb.getStatus(),
        data: hb.getData(),
      });
    }
    setSessions(infos);
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSaveConfig = () => {
    getHeartbeatManager().setGlobalConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleStopAll = () => {
    getHeartbeatManager().stopAll();
    refresh();
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)", marginBottom: 3, display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 'var(--fs-sm)', width: "100%",
    outline: "none",
  };

  const statusLabel = (s: HeartbeatStatus) => zh ? STATUS_LABELS_ZH[s] : STATUS_LABELS_EN[s];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: "var(--text-primary)" }}>
          💓 {zh ? "心跳监控" : "Heartbeat Monitor"}
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginTop: 2 }}>
          {zh ? "监控会话活动心跳，配置心跳上报端点和间隔。" : "Monitor session activity heartbeats, configure endpoint and interval."}
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[
          { label: zh ? "总计" : "Total", value: stats.total, color: "var(--text-primary)" },
          { label: zh ? "活跃" : "Active", value: stats.active, color: STATUS_COLORS.active },
          { label: zh ? "暂停" : "Paused", value: stats.paused, color: STATUS_COLORS.paused },
          { label: zh ? "停止" : "Stopped", value: stats.stopped, color: STATUS_COLORS.stopped },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, minWidth: 80, padding: "8px 12px", borderRadius: 6,
            border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
            textAlign: "center",
          }}>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Active sessions */}
      {sessions.length > 0 && (
        <div>
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
            {zh ? "会话心跳" : "Session Heartbeats"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {sessions.map(s => (
              <div key={s.sessionId} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                borderRadius: 4, border: "1px solid var(--border-primary)",
                background: "var(--bg-tertiary)", fontSize: 'var(--fs-sm)',
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: STATUS_COLORS[s.status], flexShrink: 0,
                }} />
                <span style={{ fontFamily: "monospace", color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.sessionId}
                </span>
                <span style={{ color: "var(--text-muted)" }}>{s.data.activity}</span>
                {s.data.progress !== undefined && (
                  <span style={{ color: "var(--text-muted)" }}>{s.data.progress}%</span>
                )}
                <span style={{ color: "var(--text-muted)" }}>{zh ? "消息" : "msg"}: {s.data.messageCount}</span>
                {s.data.errorCount > 0 && (
                  <span style={{ color: "var(--error)" }}>⚠️ {s.data.errorCount}</span>
                )}
                <span style={{ color: STATUS_COLORS[s.status], fontWeight: 600 }}>{statusLabel(s.status)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Config */}
      <div style={{
        padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
          {zh ? "全局配置" : "Global Configuration"}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "心跳间隔 (毫秒)" : "Interval (ms)"}</label>
            <input type="number" min={5000} step={1000} style={inputStyle} value={config.interval}
              onChange={e => setConfig({ ...config, interval: parseInt(e.target.value) || 30000 })} />
          </div>
          <div>
            <label style={labelStyle}>{zh ? "超时 (毫秒)" : "Timeout (ms)"}</label>
            <input type="number" min={1000} step={1000} style={inputStyle} value={config.timeout}
              onChange={e => setConfig({ ...config, timeout: parseInt(e.target.value) || 5000 })} />
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={labelStyle}>{zh ? "上报端点 URL (可选)" : "Endpoint URL (optional)"}</label>
          <input type="text" style={inputStyle} value={config.endpoint || ""}
            onChange={e => setConfig({ ...config, endpoint: e.target.value || undefined })}
            placeholder="https://example.com/api/heartbeat" />
          <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", marginTop: 2 }}>
            {zh ? "配置后心跳将 POST 到此 URL，留空则仅本地记录" : "If set, heartbeats are POSTed to this URL. Leave empty for local-only."}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <label style={labelStyle}>{zh ? "最大连续失败次数" : "Max Failures"}</label>
            <input type="number" min={1} max={20} style={inputStyle} value={config.maxFailures}
              onChange={e => setConfig({ ...config, maxFailures: parseInt(e.target.value) || 3 })} />
          </div>
          <div>
            <label style={labelStyle}>{zh ? "自定义请求头 (JSON)" : "Custom Headers (JSON)"}</label>
            <input type="text" style={inputStyle} value={config.headers ? JSON.stringify(config.headers) : ""}
              onChange={e => {
                try {
                  const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
                  setConfig({ ...config, headers: parsed });
                } catch {}
              }}
              placeholder='{"Authorization":"Bearer xxx"}' />
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
          <input type="checkbox" checked={config.sendMetadata}
            onChange={e => setConfig({ ...config, sendMetadata: e.target.checked })} />
          {zh ? "发送元数据（消息数、Token 使用量等）" : "Send metadata (message count, token usage, etc.)"}
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSaveConfig} style={{
            padding: "6px 16px", borderRadius: 4, fontSize: 'var(--fs-sm)',
            border: "1px solid var(--accent)", background: "var(--accent)",
            color: "#fff", cursor: "pointer",
          }}>
            {saved ? "✅ " + (zh ? "已保存" : "Saved") : (zh ? "保存配置" : "Save Config")}
          </button>
          {stats.active > 0 && (
            <button onClick={handleStopAll} style={{
              padding: "6px 16px", borderRadius: 4, fontSize: 'var(--fs-sm)',
              border: "1px solid #e74c3c", background: "none",
              color: "#e74c3c", cursor: "pointer",
            }}>
              {zh ? "停止所有心跳" : "Stop All"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
