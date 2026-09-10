import { useState, useEffect } from "react";
import {
  getSessionRecoveryService,
  type RecoveryConfig,
} from "../core/recovery/recovery";
import { useLang } from "../core/i18n/lang";

export function RecoveryPanel() {
  const lang = useLang();
  const zh = lang === "zh";
  const [summary, setSummary] = useState(() => {
    try { return getSessionRecoveryService().getRecoverySummary(); } catch { return null; }
  });
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [exportData, setExportData] = useState("");

  const refresh = () => {
    try {
      const svc = getSessionRecoveryService();
      setSummary(svc.getRecoverySummary());
      setSessions(svc.getAllSessions());
    } catch {}
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleForceSave = () => {
    try {
      getSessionRecoveryService().forceSave();
      refresh();
    } catch {}
  };

  const handleClear = () => {
    if (!confirm(zh ? "确认清除所有恢复数据？此操作不可撤销。" : "Clear all recovery data? This cannot be undone.")) return;
    try {
      getSessionRecoveryService().clear();
      refresh();
    } catch {}
  };

  const handleExport = () => {
    try {
      const data = getSessionRecoveryService().exportData();
      setExportData(data);
      setShowExport(true);
    } catch {}
  };

  const handleDeleteSession = (id: string) => {
    if (!confirm(zh ? "删除此会话的恢复数据？" : "Delete this session's recovery data?")) return;
    try {
      getSessionRecoveryService().deleteSession(id);
      if (selectedSessionId === id) setSelectedSessionId(null);
      refresh();
    } catch {}
  };

  const selectedSession = sessions.find(s => s.id === selectedSessionId);

  return (
    <div className="recovery-panel">
      <div>
        <div className="recovery-title">
          🔄 {zh ? "多层会话恢复" : "Multi-layer Session Recovery"}
        </div>
        <div className="recovery-subtitle">
          {zh ? "自动保存会话状态，崩溃后可恢复。数据持久化到 SQLite。" : "Auto-saves session state for crash recovery. Data persisted to SQLite."}
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="stat-cards">
          {[
            { label: zh ? "总会话数" : "Total Sessions", value: summary.totalSessions, color: "var(--text-primary)" },
            { label: zh ? "总消息数" : "Total Messages", value: summary.totalMessages, color: "var(--text-primary)" },
            { label: zh ? "可恢复会话" : "Recoverable", value: summary.recoverableSessions, color: "var(--success)" },
            { label: zh ? "最后保存" : "Last Saved", value: summary.lastSaved > 0 ? new Date(summary.lastSaved).toLocaleTimeString() : "-", color: "var(--text-secondary)" },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-card-value" style={{ color: s.color }}>{s.value}</div>
              <div className="stat-card-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Session list */}
      <div>
        <div className="panel-section-title">
          {zh ? "已保存的会话" : "Saved Sessions"} ({sessions.length})
        </div>
        {sessions.length === 0 ? (
          <div className="panel-empty">
            {zh ? "暂无已保存的会话" : "No saved sessions"}
          </div>
        ) : (
          <div className="recovery-list">
            {sessions.map(s => {
              const active = selectedSessionId === s.id;
              const msgCount = s.messages?.length || 0;
              return (
                <div
                  key={s.id}
                  onClick={() => setSelectedSessionId(active ? null : s.id)}
                  className={`recovery-item${active ? " is-active" : ""}`}
                >
                  <span className="recovery-item-icon">{msgCount > 0 ? "💬" : "📭"}</span>
                  <div className="recovery-item-body">
                    <div className="recovery-item-id">
                      {s.id.substring(0, 16)}...
                    </div>
                    <div className="recovery-item-meta">
                      {zh ? "消息" : "msgs"}: {msgCount} · {zh ? "更新" : "updated"}: {new Date(s.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  {s.projectId && (
                    <span className="recovery-item-project">
                      {s.projectId.substring(0, 8)}
                    </span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                    className="recovery-item-delete"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected session detail */}
      {selectedSession && (
        <div className="recovery-detail">
          <div className="recovery-detail-title">
            {zh ? "会话详情" : "Session Details"}
          </div>
          <div className="recovery-detail-grid">
            <div><span className="recovery-detail-key">ID: </span><span className="mono">{selectedSession.id}</span></div>
            <div><span className="recovery-detail-key">{zh ? "项目" : "Project"}: </span>{selectedSession.projectId || "-"}</div>
            <div><span className="recovery-detail-key">{zh ? "消息数" : "Messages"}: </span>{selectedSession.messages?.length || 0}</div>
            <div><span className="recovery-detail-key">{zh ? "创建时间" : "Created"}: </span>{new Date(selectedSession.createdAt).toLocaleString()}</div>
            <div><span className="recovery-detail-key">{zh ? "更新时间" : "Updated"}: </span>{new Date(selectedSession.updatedAt).toLocaleString()}</div>
            {selectedSession.model && <div><span className="recovery-detail-key">{zh ? "模型" : "Model"}: </span>{selectedSession.model}</div>}
          </div>

          {/* Message preview */}
          {selectedSession.messages && selectedSession.messages.length > 0 && (
            <div className="recovery-messages">
              <div className="recovery-messages-title">
                {zh ? "最近消息" : "Recent Messages"}
              </div>
              <div className="recovery-messages-list">
                {selectedSession.messages.slice(-5).map((m: any, i: number) => (
                  <div key={i} className="recovery-message">
                    <span className={`recovery-message-role${m.role === "user" ? " is-user" : ""}`}>
                      {m.role}:
                    </span>{" "}
                    {(m.parts?.[0]?.content || m.content || "").substring(0, 100)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="recovery-actions">
        <button onClick={handleForceSave} className="panel-btn">
          💾 {zh ? "强制保存" : "Force Save"}
        </button>
        <button onClick={handleExport} className="panel-btn">
          📤 {zh ? "导出数据" : "Export Data"}
        </button>
        <button onClick={handleClear} className="panel-btn panel-btn--danger">
          🗑️ {zh ? "清除所有" : "Clear All"}
        </button>
      </div>

      {/* Export preview */}
      {showExport && exportData && (
        <div>
          <div className="recovery-export-header">
            <span className="recovery-export-title">
              {zh ? "导出数据" : "Export Data"}
            </span>
            <button onClick={() => navigator.clipboard?.writeText(exportData)} className="panel-btn panel-btn--sm">
              📋 {zh ? "复制" : "Copy"}
            </button>
          </div>
          <pre className="recovery-export-pre">
            {exportData.substring(0, 5000)}{exportData.length > 5000 ? "\n...(truncated)" : ""}
          </pre>
        </div>
      )}
    </div>
  );
}
