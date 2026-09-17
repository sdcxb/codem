import { useState, useEffect, useRef } from "react";
import { getSnapshotService, type Snapshot } from "../core/snapshot/snapshot";
import { DiffViewer } from "./DiffViewer";
import { readFile } from "../core/file-api";
import { reportActionFailure } from "../core/storage/persist-failure";
import { Camera, Clock, RefreshCw, Search, Undo, Folder, ChevronDown, ChevronRight } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";

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

interface ToastMsg {
  type: "success" | "error";
  text: string;
}

export function SnapshotPanel({ cwd, onClose, onRestore }: SnapshotPanelProps) {
  const CloseIcon = ActionIcons.close;
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  /** P2-9(b)：同 tick 守卫（state 更新要等下一次渲染，双击/连点拦不住） */
  const restoringRef = useRef<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  /** P2-9(a)：读取失败时不许再显示「暂无快照」（否则失败被伪装成「没有数据」） */
  const [readFailed, setReadFailed] = useState(false);
  // S4: Diff viewer state
  const [diffFile, setDiffFile] = useState<{ path: string; before: string; after: string } | null>(null);

  useEffect(() => {
    loadSnapshots();
  }, [cwd]);

  /**
   * P2-9(a)：读取失败必须可见，且**不能同时**显示「暂无快照」。
   * 原实现是空 `catch {}` —— 列表读不出来时界面与「真的没有快照」完全一致，
   * 用户会以为快照丢了。这里不改控制流，但走可见通道，并用 readFailed 抑制空态文案。
   */
  const loadSnapshots = async () => {
    setLoading(true);
    try {
      const service = getSnapshotService(cwd);
      const data = await service.getAll();
      setSnapshots(data);
      setReadFailed(false);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setReadFailed(true);
      setToast({ type: "error", text: `读取快照失败：${msg}（列表可能不是最新的）` });
      reportActionFailure("snapshotPanel.getAll", e, "快照列表未能读取");
    }
    setLoading(false);
  };

  const handleRestore = async (snapshotId: string) => {
    // P2-9(b)：回滚守卫必须是**全局**的，不能按快照粒度。
    // 原实现 `restoring === snapshotId` 只禁用被点的那一个按钮 —— 展开 A 点回滚、
    // 展开 B 再点回滚会并发执行，两个 restore 交叉写/删同一 cwd，最终工作区
    // 既不匹配 A 也不匹配 B。这里在同 tick 内也拦得住（state 依赖重渲染，ref 不依赖）。
    if (restoringRef.current) {
      setToast({ type: "error", text: "已有回滚正在进行，请等待它结束" });
      setTimeout(() => setToast(null), 3000);
      return;
    }
    restoringRef.current = snapshotId;
    setRestoring(snapshotId);
    try {
      const service = getSnapshotService(cwd);
      const changes = await service.restore(snapshotId);
      onRestore?.(snapshotId);
      await loadSnapshots();
      // 构造回滚结果提示
      const restoredCount = changes.length;
      const deletedCount = changes.filter((c) => c.type === "deleted").length;
      const modifiedCount = changes.filter((c) => c.type === "modified").length;
      const addedCount = changes.filter((c) => c.type === "added").length;
      const parts: string[] = [];
      if (modifiedCount > 0) parts.push(`恢复 ${modifiedCount} 个文件`);
      if (addedCount > 0) parts.push(`写入 ${addedCount} 个文件`);
      if (deletedCount > 0) parts.push(`删除 ${deletedCount} 个文件`);
      const summary = parts.length > 0 ? parts.join("，") : "没有文件需要回滚";
      setToast({ type: "success", text: `回滚成功！${summary}（共 ${restoredCount} 个文件）` });
    } catch (e: any) {
      setToast({ type: "error", text: `回滚失败：${e?.message || "未知错误"}` });
    }
    restoringRef.current = null;
    setRestoring(null);
    // 3秒后自动清除提示
    setTimeout(() => setToast(null), 3000);
  };

  const handleViewDiff = async (filePath: string, snapshotContent: string, isNew: boolean) => {
    try {
      let currentContent = "";
      try {
        currentContent = await readFile(filePath);
      } catch {
        // File doesn't exist currently
      }
      setDiffFile({
        path: filePath,
        before: isNew ? "" : snapshotContent,  // snapshot has the original content
        after: currentContent,                    // current file content
      });
    } catch (e: any) {
      setToast({ type: "error", text: `无法读取文件：${e?.message || "未知错误"}` });
      setTimeout(() => setToast(null), 3000);
    }
  };

  return (
    <div className="snapshot-panel">
      <div className="snapshot-panel-header">
        <div className="snapshot-panel-title">
          <Camera size={16} style={{ color: 'var(--accent)' }} />
          <span>文件快照</span>
        </div>
        <button className="snapshot-panel-close" onClick={onClose}><CloseIcon size={14} /></button>
      </div>

      {toast && (
        <div className={`snapshot-toast snapshot-toast-${toast.type}`}>
          {toast.text}
        </div>
      )}

      <div className="snapshot-panel-actions">
        <button className="snapshot-refresh-btn" onClick={loadSnapshots} disabled={loading}>
          {loading ? <Clock size={12} /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>

      <div className="snapshot-list">
        {loading && snapshots.length === 0 && (
          <div className="snapshot-loading">加载中...</div>
        )}
        {!loading && snapshots.length === 0 && !readFailed && (
          <div className="snapshot-empty">暂无快照</div>
        )}
        {!loading && snapshots.length === 0 && readFailed && (
          <div className="snapshot-empty">快照列表读取失败，请查看上方提示后重试</div>
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
                  <Folder size={12} className="icon-inline" /> {snapshot.files.length} 个文件
                </span>
                <span className="snapshot-item-arrow">
                  {expandedId === snapshot.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
                        <li key={i} className="snapshot-file-item">
                          <span className="mono snapshot-file-path">{file.path}</span>
                          <button
                            className="snapshot-diff-btn"
                            onClick={() => handleViewDiff(file.path, file.content, file.isNew || false)}
                            title="查看变更"
                          >
                            <Search size={12} className="icon-inline" /> Diff
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="snapshot-actions">
                  <button
                    className="snapshot-restore-btn"
                    onClick={() => handleRestore(snapshot.id)}
                    disabled={restoring !== null}
                  >
                    {restoring === snapshot.id ? <><Clock size={12} /> 恢复中...</> : <><Undo size={12} /> 回滚到此快照</>}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* S4: Diff Viewer Modal */}
      {diffFile && (
        <div className="diff-viewer-overlay" onClick={() => setDiffFile(null)}>
          <div className="diff-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <DiffViewer
              filePath={diffFile.path}
              before={diffFile.before}
              after={diffFile.after}
              onClose={() => setDiffFile(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
