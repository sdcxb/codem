import { useState, useEffect } from "react";
import { Spinner } from "./ui/Spinner";
import { getSessionRecoveryService } from "../core/recovery/recovery";
import type { Session } from "../core/llm/session";
import { useProjectStore } from "../core/store";
import { reportActionFailure } from "../core/storage/persist-failure";
import { useLang } from "../core/i18n/lang";
import { RotateCcw, Clock, Undo, Trash2, User, Bot, Settings as SettingsIcon } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";

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
  const CloseIcon = ActionIcons.close;
  const lang = useLang();
  const isZh = lang === "zh";
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
  /**
   * ## 第 184 波（UI 审计 F4）：这一屏原来有三处「假成功 / 假空」
   *
   * ① `catch {}` + `sessions.length === 0` → 「暂无可恢复的会话」：
   *    **把"读不到"说成"没有"**（这条通道存在的唯一理由就是"会话可能丢了"，误报代价最高）；
   * ② 无当前项目时点「恢复此会话」**毫无反应**（`if (!currentProject) return;`，按钮像坏的）；
   * ③ `switchSession` 找不到会话时是**静默 no-op**，而恢复列表与 store 的会话集合
   *    不保证同源 ⇒ 弹窗照常关闭、什么都没发生，用户以为恢复成功了。
   *
   * 三处现在都如实交代：读失败给一行**可读的错误 + 重试**；点不动就说明为什么；
   * 切换失败**不关窗**并给出失败原因。
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { currentProject, switchSession } = useProjectStore();

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = () => {
    setLoading(true);
    setLoadError(null);
    try {
      const recovery = getSessionRecoveryService();
      const allSessions = recovery.getAllSessions();
      setSessions(allSessions);
      setSummary(recovery.getRecoverySummary());
    } catch (e) {
      /**
       * ★ 读失败**不许**渲染成"暂无可恢复的会话"。列表**保持原样**（不清空），
       * 并把失败上报到仓库统一的可见通道（`reportActionFailure`）。
       */
      setLoadError(
        isZh
          ? `恢复数据读取失败：下面的列表可能不是最新的（这不代表没有可恢复的会话）。原因：${e instanceof Error ? e.message : String(e)}`
          : `Failed to read recovery data — the list below may be stale (this does NOT mean there is nothing to recover). Reason: ${e instanceof Error ? e.message : String(e)}`,
      );
      reportActionFailure("sessionRecovery.loadSessions", e, "恢复会话列表没有读出来（这不代表没有可恢复的会话）");
    }
    setLoading(false);
  };

  const handleRecover = async (session: Session) => {
    setActionError(null);
    /**
     * ② 无当前项目：**明说**，不许静默返回（原来按钮毫无反应）。
     */
    if (!currentProject) {
      setActionError(
        isZh
          ? "没有选中的项目，无法恢复这个会话 —— 请先在侧栏选择一个项目，再回来恢复。"
          : "No project is selected, so this session cannot be recovered. Pick a project in the sidebar first.",
      );
      return;
    }
    setRecovering(session.id);
    try {
      /**
       * ③ 判据取**切换的真实结果**：`switchSession` 现在返回 boolean
       *    （找不到该会话 = false，不再静默 no-op）。失败时**不关窗**。
       */
      const switched = switchSession(session.id);
      if (!switched) {
        const msg = isZh
          ? `恢复失败：会话 ${session.id} 不在当前会话列表里（可能属于另一个项目，或列表尚未加载）。已保持原样，没有任何切换发生。`
          : `Recovery failed: session ${session.id} is not in the current session list (it may belong to another project). Nothing was switched.`;
        setActionError(msg);
        reportActionFailure("sessionRecovery.handleRecover", new Error("switchSession 找不到该会话"), msg);
        return;
      }
      onClose();
    } catch (e) {
      const msg = isZh
        ? `恢复失败：${e instanceof Error ? e.message : String(e)}（已保持原样）`
        : `Recovery failed: ${e instanceof Error ? e.message : String(e)}`;
      setActionError(msg);
      reportActionFailure("sessionRecovery.handleRecover", e, "恢复会话失败，未发生切换");
    } finally {
      setRecovering(null);
    }
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
          <span className="session-recovery-icon"><RotateCcw size={16} /></span>
          <span>会话恢复</span>
        </div>
        <button aria-label="关闭" title="关闭" className="session-recovery-close" onClick={onClose}><CloseIcon size={14} /></button>
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
        {/*
          三态（第 184 波 F4）：**读不到 ≠ 没有**。
          原来只有 `!loading && sessions.length === 0 → 「暂无可恢复的会话」`，
          把"读失败"也说成了"没有"。现在读失败单独一支，并给重试入口。
        */}
        {loadError && (
          <div className="session-recovery-error" data-testid="session-recovery-read-error" role="alert">
            <span className="session-recovery-error-text">{loadError}</span>
            <button type="button" className="session-recovery-retry" onClick={loadSessions}>
              {isZh ? "重新读取" : "Retry"}
            </button>
          </div>
        )}
        {actionError && (
          <div className="session-recovery-error" data-testid="session-recovery-action-error" role="alert">
            <span className="session-recovery-error-text">{actionError}</span>
          </div>
        )}
        <div className="session-list">
          {loading && sessions.length === 0 && (
            <div className="empty-hint"><Spinner size="sm" label="" /> 加载中...</div>
          )}
          {/* ⚠️ 只有"读到了、确实空"才是「暂无可恢复的会话」（读失败时上面那支已经说了真话） */}
          {!loading && !loadError && sessions.length === 0 && (
            <div className="empty-hint">暂无可恢复的会话</div>
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
                        {msg.role === "user" ? <User size={12} /> : msg.role === "assistant" ? <Bot size={12} /> : <SettingsIcon size={12} />}
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
                {recovering === selectedSession.id ? <><Clock size={12} /> 恢复中...</> : <><Undo size={12} /> 恢复此会话</>}
              </button>
              <button
                className="session-delete-btn"
                onClick={() => handleDelete(selectedSession.id)}
              >
                <Trash2 size={12} /> 删除
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
