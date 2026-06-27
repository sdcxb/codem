import { useState, useEffect } from "react";
import { getSessionRecoveryService } from "../core/recovery/recovery";
import type { Session } from "../core/llm/session";
import { useProjectStore } from "../core/store";

interface SessionRecoveryProps {
  onClose: () => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN");
}

function formatDuration(start: number, end?: number): string {
  const duration = (end || Date.now()) - start;
  if (duration < 60000) return `${Math.floor(duration / 1000)}秒`;
  if (duration < 3600000) return `${Math.floor(duration / 60000)}分钟`;
  return `${Math.floor(duration / 3600000)}小时`;
}

export function SessionRecovery({ onClose }: SessionRecoveryProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    totalSessions: number;
    totalMessages: number;
    lastSaved: number;
    recoverableSessions: number;
  } | null>(null);

  const { currentProject, switchSession } = useProjectStore();

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = () => {
    setLoading(true);
    try {
      const recovery = getSessionRecoveryService();
      const allSessions = recovery.getAllSessions();
      setSessions(allSessions);
      setSummary(recovery.getRecoverySummary());
    } catch {}
    setLoading(false);
  };

  const handleRecover = async (session: Session) => {
    if (!currentProject) return;
    setRecovering(session.id);
    try {
      // Switch to the recovered session
      switchSession(session.id);
      onClose();
    } catch {}
    setRecovering(null);
  };

  const handleDelete = (sessionId: string) => {
    const recovery = getSessionRecoveryService();
    recovery.deleteSession(sessionId);
    loadSessions();
    if (selectedSession?.id === sessionId) {
      setSelectedSession(null);
    }
  };

  return (
    <div className="session-recovery">
      <div className="session-recovery-header">
        <div className="session-recovery-title">
          <span className="session-recovery-icon">🔄</span>
          <span>会话恢复</span>
        </div>
        <button className="session-recovery-close" onClick={onClose}>✕</button>
      </div>

      {summary && (
        <div className="session-recovery-stats">
          <div className="session-stat">
            <span className="session-stat-value">{summary.totalSessions}</span>
            <span className="session-stat-label">总会话</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-value">{summary.totalMessages}</span>
            <span className="session-stat-label">总消息</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-value">{summary.recoverableSessions}</span>
            <span className="session-stat-label">可恢复</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-value">{formatTime(summary.lastSaved)}</span>
            <span className="session-stat-label">最后保存</span>
          </div>
        </div>
      )}

      <div className="session-recovery-content">
        <div className="session-list">
          {loading && sessions.length === 0 && (
            <div className="session-loading">加载中...</div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="session-empty">暂无可恢复的会话</div>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${selectedSession?.id === session.id ? "selected" : ""}`}
              onClick={() => setSelectedSession(selectedSession?.id === session.id ? null : session)}
            >
              <div className="session-item-header">
                <span className="session-item-title">{session.title}</span>
                <span className="session-item-messages">
                  {session.messages.length} 条消息
                </span>
              </div>
              <div className="session-item-meta">
                <span>{formatTime(session.createdAt)}</span>
                <span>{formatDuration(session.createdAt, session.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>

        {selectedSession && (
          <div className="session-detail">
            <div className="session-detail-header">
              <h3>{selectedSession.title}</h3>
            </div>

            <div className="session-detail-section">
              <label>会话 ID</label>
              <span className="session-detail-mono">{selectedSession.id}</span>
            </div>

            <div className="session-detail-section">
              <label>创建时间</label>
              <span>{formatTime(selectedSession.createdAt)}</span>
            </div>

            <div className="session-detail-section">
              <label>最后活动</label>
              <span>{formatTime(selectedSession.updatedAt)}</span>
            </div>

            <div className="session-detail-section">
              <label>消息数量</label>
              <span>{selectedSession.messages.length}</span>
            </div>

            {selectedSession.messages.length > 0 && (
              <div className="session-detail-section">
                <label>最近消息预览</label>
                <div className="session-preview">
                  {selectedSession.messages.slice(-5).map((msg: any, i: number) => (
                    <div key={i} className={`session-preview-msg ${msg.role}`}>
                      <span className="session-preview-role">
                        {msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "⚙️"}
                      </span>
                      <span className="session-preview-content">
                        {typeof msg.content === "string"
                          ? msg.content.substring(0, 100)
                          : JSON.stringify(msg.content).substring(0, 100)}
                        ...
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="session-detail-actions">
              <button
                className="session-recover-btn"
                onClick={() => handleRecover(selectedSession)}
                disabled={recovering === selectedSession.id}
              >
                {recovering === selectedSession.id ? "⏳ 恢复中..." : "↩️ 恢复此会话"}
              </button>
              <button
                className="session-delete-btn"
                onClick={() => handleDelete(selectedSession.id)}
              >
                🗑️ 删除
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
