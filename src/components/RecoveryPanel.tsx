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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: "var(--text-primary)" }}>
          🔄 {zh ? "多层会话恢复" : "Multi-layer Session Recovery"}
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginTop: 2 }}>
          {zh ? "自动保存会话状态，崩溃后可恢复。数据持久化到 SQLite。" : "Auto-saves session state for crash recovery. Data persisted to SQLite."}
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            { label: zh ? "总会话数" : "Total Sessions", value: summary.totalSessions, color: "var(--text-primary)" },
            { label: zh ? "总消息数" : "Total Messages", value: summary.totalMessages, color: "var(--text-primary)" },
            { label: zh ? "可恢复会话" : "Recoverable", value: summary.recoverableSessions, color: "var(--success)" },
            { label: zh ? "最后保存" : "Last Saved", value: summary.lastSaved > 0 ? new Date(summary.lastSaved).toLocaleTimeString() : "-", color: "var(--text-secondary)" },
          ].map(s => (
            <div key={s.label} style={{
              flex: 1, minWidth: 100, padding: "8px 12px", borderRadius: 6,
              border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
              textAlign: "center",
            }}>
              <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Session list */}
      <div>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
          {zh ? "已保存的会话" : "Saved Sessions"} ({sessions.length})
        </div>
        {sessions.length === 0 ? (
          <div style={{
            padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 'var(--fs-sm)',
            background: "var(--bg-tertiary)", borderRadius: 6, border: "1px dashed var(--border-primary)",
          }}>
            {zh ? "暂无已保存的会话" : "No saved sessions"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 300, overflowY: "auto" }}>
            {sessions.map(s => {
              const active = selectedSessionId === s.id;
              const msgCount = s.messages?.length || 0;
              return (
                <div
                  key={s.id}
                  onClick={() => setSelectedSessionId(active ? null : s.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                    borderRadius: 4, cursor: "pointer", fontSize: 'var(--fs-sm)',
                    border: `1px solid ${active ? "var(--accent)" : "var(--border-primary)"}`,
                    background: active ? "rgba(99, 102, 241, 0.1)" : "var(--bg-tertiary)",
                  }}
                >
                  <span style={{ fontSize: 'var(--fs-md)' }}>{msgCount > 0 ? "💬" : "📭"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)", fontFamily: "monospace" }}>
                      {s.id.substring(0, 16)}...
                    </div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                      {zh ? "消息" : "msgs"}: {msgCount} · {zh ? "更新" : "updated"}: {new Date(s.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  {s.projectId && (
                    <span style={{ fontSize: 'var(--fs-xs)', padding: "1px 6px", borderRadius: 3, background: "var(--bg-secondary)", color: "var(--text-secondary)" }}>
                      {s.projectId.substring(0, 8)}
                    </span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                    style={{ fontSize: 'var(--fs-xs)', padding: "2px 6px", borderRadius: 3, border: "1px solid #e74c3c", background: "none", color: "#e74c3c", cursor: "pointer" }}
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
        <div style={{
          padding: 12, borderRadius: 8, border: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)", fontSize: 'var(--fs-sm)',
        }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--fs-base)', marginBottom: 8, color: "var(--text-primary)" }}>
            {zh ? "会话详情" : "Session Details"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <div><span style={{ color: "var(--text-muted)" }}>ID: </span><span style={{ fontFamily: "monospace" }}>{selectedSession.id}</span></div>
            <div><span style={{ color: "var(--text-muted)" }}>{zh ? "项目" : "Project"}: </span>{selectedSession.projectId || "-"}</div>
            <div><span style={{ color: "var(--text-muted)" }}>{zh ? "消息数" : "Messages"}: </span>{selectedSession.messages?.length || 0}</div>
            <div><span style={{ color: "var(--text-muted)" }}>{zh ? "创建时间" : "Created"}: </span>{new Date(selectedSession.createdAt).toLocaleString()}</div>
            <div><span style={{ color: "var(--text-muted)" }}>{zh ? "更新时间" : "Updated"}: </span>{new Date(selectedSession.updatedAt).toLocaleString()}</div>
            {selectedSession.model && <div><span style={{ color: "var(--text-muted)" }}>{zh ? "模型" : "Model"}: </span>{selectedSession.model}</div>}
          </div>

          {/* Message preview */}
          {selectedSession.messages && selectedSession.messages.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {zh ? "最近消息" : "Recent Messages"}
              </div>
              <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {selectedSession.messages.slice(-5).map((m: any, i: number) => (
                  <div key={i} style={{
                    padding: "4px 6px", borderRadius: 3, background: "var(--bg-tertiary)",
                    fontSize: 'var(--fs-xs)', color: "var(--text-secondary)",
                  }}>
                    <span style={{ fontWeight: 600, color: m.role === "user" ? "var(--info)" : "var(--accent)" }}>
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={handleForceSave} style={{
          padding: "6px 14px", borderRadius: 4, fontSize: 'var(--fs-sm)',
          border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
          color: "var(--text-primary)", cursor: "pointer",
        }}>
          💾 {zh ? "强制保存" : "Force Save"}
        </button>
        <button onClick={handleExport} style={{
          padding: "6px 14px", borderRadius: 4, fontSize: 'var(--fs-sm)',
          border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
          color: "var(--text-primary)", cursor: "pointer",
        }}>
          📤 {zh ? "导出数据" : "Export Data"}
        </button>
        <button onClick={handleClear} style={{
          padding: "6px 14px", borderRadius: 4, fontSize: 'var(--fs-sm)',
          border: "1px solid #e74c3c", background: "none",
          color: "#e74c3c", cursor: "pointer",
        }}>
          🗑️ {zh ? "清除所有" : "Clear All"}
        </button>
      </div>

      {/* Export preview */}
      {showExport && exportData && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-secondary)" }}>
              {zh ? "导出数据" : "Export Data"}
            </span>
            <button onClick={() => navigator.clipboard?.writeText(exportData)} style={{
              padding: "2px 8px", borderRadius: 3, fontSize: 'var(--fs-xs)',
              border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
              color: "var(--text-primary)", cursor: "pointer",
            }}>
              📋 {zh ? "复制" : "Copy"}
            </button>
          </div>
          <pre style={{
            fontSize: 'var(--fs-xs)', padding: 8, background: "var(--bg-tertiary)", borderRadius: 4,
            maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", margin: 0,
            color: "var(--text-secondary)", fontFamily: "monospace",
            border: "1px solid var(--border-primary)",
          }}>
            {exportData.substring(0, 5000)}{exportData.length > 5000 ? "\n...(truncated)" : ""}
          </pre>
        </div>
      )}
    </div>
  );
}
