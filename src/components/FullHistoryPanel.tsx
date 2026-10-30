/**
 * 完整历史面板（检查点模式的第一步 UI）。
 *
 * 数据源是 `listTimelineMessages`：**含**旧压缩 hidden / 索引裁剪 trimmed 行，
 * 不应用模型 cutoff；因此用户能看到压缩前的提问、思考、回答与工具调用。
 * 面板只读：编辑/重发/删除产出文件等动作仍只在模型视图里做，避免用时间线下标
 * 误操作主消息数组。
 */
import { useEffect, useRef, useState } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { readContextHistory } from "../core/storage/context-history";
import { migrateSessionLegacyHistory } from "../core/storage/context-migration";
import { isCompactionMarker } from "../core/llm/compaction-budget";
import type { Message } from "../store";

interface FullHistoryPanelProps {
  open: boolean;
  sessionId: string;
  onClose: () => void;
}

function roleLabel(role: Message["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return "系统";
}

function timeLabel(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ts);
  }
}

export function FullHistoryPanel({ open, sessionId, onClose }: FullHistoryPanelProps) {
  const [timeline, setTimeline] = useState<Message[]>([]);
  const [modelMessages, setModelMessages] = useState<Message[]>([]);
  const [view, setView] = useState<"timeline" | "model">("timeline");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairText, setRepairText] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const reload = () => {
    const snapshot = readContextHistory(sessionId);
    setTimeline(snapshot.timeline);
    setModelMessages(snapshot.model);
  };

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const snapshot = readContextHistory(sessionId);
      setTimeline(snapshot.timeline);
      setModelMessages(snapshot.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTimeline([]);
      setModelMessages([]);
    } finally {
      setLoading(false);
    }
  }, [open, sessionId]);

  useDismissableLayer({ open, onDismiss: onClose });

  useEffect(() => {
    if (!open) return;
    // 焦点放到关闭按钮；Esc/遮罩关闭与焦点归还由 useDismissableLayer 统一处理。
    const t = setTimeout(() => closeRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const messages = view === "model" ? modelMessages : timeline;
  const legacyHidden = timeline.filter(
    (m) => Number((m as unknown as { hidden?: number }).hidden ?? 0) === 1
      && Number((m as unknown as { trimmed?: number }).trimmed ?? 0) !== 1,
  ).length;

  const repair = async () => {
    setRepairing(true);
    setRepairText(null);
    try {
      const report = await migrateSessionLegacyHistory(sessionId);
      setRepairText(
        report.hiddenRows === 0
          ? "没有需要回填的旧压缩消息。"
          : `回填完成：${report.appended} 条已写入权威日志，${report.alreadyDurable} 条已存在，${report.failed} 条失败。`,
      );
      reload();
    } catch (e) {
      setRepairText(`回填失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-editor context-history-panel"
        role="dialog"
        aria-modal="true"
        aria-label="完整历史"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(920px, 94vw)", maxHeight: "88vh", display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--border-primary)" }}>
          <strong>{view === "model" ? "模型视图" : "完整历史"}</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>
            历史 {timeline.length} 条 · 模型可见 {modelMessages.length} 条（不计入水位）
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="context-history-close"
            aria-pressed={view === "timeline"}
            onClick={() => setView("timeline")}
            title="包含被压缩的旧消息"
          >
            完整
          </button>
          <button
            className="context-history-close"
            aria-pressed={view === "model"}
            onClick={() => setView("model")}
            title="模型/Agent 实际看到的集合"
          >
            模型
          </button>
          {legacyHidden > 0 && (
            <button
              className="context-history-close"
              disabled={repairing}
              onClick={repair}
              title="把旧压缩 hidden 行以正常记录回填到权威日志，防止索引重建后丢失"
            >
              {repairing ? "回填中…" : "回填旧历史"}
            </button>
          )}
          <span style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>只读</span>
          <button ref={closeRef} className="context-history-close" onClick={onClose} aria-label="关闭完整历史">
            关闭
          </button>
        </div>

        <div style={{ overflow: "auto", padding: "12px 16px" }}>
          {repairText && <div className="context-history-state">{repairText}</div>}
          {loading && <div className="context-history-state">正在读取完整历史…</div>}
          {!loading && error && (
            <div className="context-history-state" role="alert">
              读取完整历史失败：{error}
            </div>
          )}
          {!loading && !error && messages.length === 0 && (
            <div className="context-history-state">这个会话还没有历史消息。</div>
          )}
          {!loading && !error && messages.map((m) => {
            const marker = isCompactionMarker(m as never);
            return (
              <article
                key={m.id}
                className={marker ? "context-history-item context-history-checkpoint" : "context-history-item"}
                data-testid={marker ? "history-checkpoint" : "history-message"}
              >
                <header style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 }}>
                  <strong>{marker ? "上下文检查点" : roleLabel(m.role)}</strong>
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>{timeLabel(m.timestamp)}</span>
                  {marker && <span style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>模型从这里开始看</span>}
                </header>
                {m.reasoning && (
                  <details style={{ marginBottom: 6 }}>
                    <summary style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>思考过程</summary>
                    <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0", fontSize: "var(--fs-xs)" }}>{m.reasoning}</pre>
                  </details>
                )}
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "var(--fs-sm)" }}>{m.content}</div>
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>
                      工具调用 {m.toolCalls.length} 次
                    </summary>
                    {m.toolCalls.map((tc) => (
                      <div key={tc.id} style={{ marginTop: 4, fontSize: "var(--fs-xs)" }}>
                        <code>{tc.tool}</code>
                        <span style={{ color: "var(--text-secondary)" }}> · {tc.status}</span>
                        {tc.result && (
                          <pre style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto", margin: "2px 0 0" }}>
                            {tc.result}
                          </pre>
                        )}
                      </div>
                    ))}
                  </details>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
