import { useState, useEffect } from "react";
import { getSnapshotService, type Snapshot } from "../core/snapshot/snapshot";

interface SnapshotPanelProps {
  cwd: string;
  onClose: () => void;
  onRestore?: (snapshotId: string) => void;
}

function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

export function SnapshotPanel({ cwd, onClose, onRestore }: SnapshotPanelProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loadSnapshots();
  }, [cwd]);

  const loadSnapshots = async () => {
    setLoading(true);
    try {
      const service = getSnapshotService(cwd);
      const data = await service.getAll();
      setSnapshots(data);
    } catch {}
    setLoading(false);
  };

  const handleRestore = async (snapshotId: string) => {
    setRestoring(snapshotId);
    try {
      const service = getSnapshotService(cwd);
      await service.restore(snapshotId);
      onRestore?.(snapshotId);
      // Reload to show updated state
      await loadSnapshots();
    } catch {}
    setRestoring(null);
  };

  return (
    <div className="snapshot-panel">
      <div className="snapshot-panel-header">
        <div className="snapshot-panel-title">
          <span className="snapshot-panel-icon">📸</span>
          <span>文件快照</span>
        </div>
        <button className="snapshot-panel-close" onClick={onClose}>✕</button>
      </div>

      <div className="snapshot-panel-actions">
        <button className="snapshot-refresh-btn" onClick={loadSnapshots} disabled={loading}>
          {loading ? "⏳" : "🔄"} 刷新
        </button>
      </div>

      <div className="snapshot-list">
        {loading && snapshots.length === 0 && (
          <div className="snapshot-loading">加载中...</div>
        )}
        {!loading && snapshots.length === 0 && (
          <div className="snapshot-empty">暂无快照</div>
        )}
        {snapshots.map((snapshot) => (
          <div key={snapshot.id} className="snapshot-item">
            <div
              className="snapshot-item-header"
              onClick={() => setExpandedId(expandedId === snapshot.id ? null : snapshot.id)}
            >
              <div className="snapshot-item-info">
                <span className="snapshot-item-id">{snapshot.id.slice(0, 16)}...</span>
                <span className="snapshot-item-time">{formatTime(snapshot.timestamp)}</span>
              </div>
              <div className="snapshot-item-meta">
                <span className="snapshot-item-files">
                  📁 {snapshot.files.length} 个文件
                </span>
                <span className="snapshot-item-arrow">
                  {expandedId === snapshot.id ? "▼" : "▶"}
                </span>
              </div>
            </div>

            {expandedId === snapshot.id && (
              <div className="snapshot-item-detail">
                {snapshot.description && (
                  <div className="snapshot-description">{snapshot.description}</div>
                )}
                <div className="snapshot-info-grid">
                  <div className="snapshot-info-field">
                    <label>会话 ID</label>
                    <span className="mono">{snapshot.sessionId}</span>
                  </div>
                  <div className="snapshot-info-field">
                    <label>消息索引</label>
                    <span>{snapshot.messageIndex}</span>
                  </div>
                </div>

                {snapshot.files.length > 0 && (
                  <div className="snapshot-files">
                    <label>已记录文件</label>
                    <ul>
                      {snapshot.files.map((file, i) => (
                        <li key={i} className="mono">{file.path}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="snapshot-actions">
                  <button
                    className="snapshot-restore-btn"
                    onClick={() => handleRestore(snapshot.id)}
                    disabled={restoring === snapshot.id}
                  >
                    {restoring === snapshot.id ? "⏳ 恢复中..." : "↩️ 回滚到此快照"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
