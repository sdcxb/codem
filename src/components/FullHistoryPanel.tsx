/**
 * 完整历史面板（检查点模式的第一步 UI）。
 *
 * 数据源是 `listTimelineMessages`：**含**旧压缩 hidden / 索引裁剪 trimmed 行，
 * 不应用模型 cutoff；因此用户能看到压缩前的提问、思考、回答与工具调用。
 * 面板只读：编辑/重发/删除产出文件等动作仍只在模型视图里做，避免用时间线下标
 * 误操作主消息数组。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { readContextHistory } from "../core/storage/context-history";
import { migrateSessionLegacyHistory } from "../core/storage/context-migration";
import { rollbackSessionToClassicHidden } from "../core/storage/context-rollback";
import { syncContextEpochs, listContextEpochs, type ContextEpochRow } from "../core/storage/context-epochs";
import { hasStoragePort } from "../core/storage/port";
import { confirmDialog } from "../core/ui/native-dialog";
import { isCompactionMarker } from "../core/llm/compaction-budget";
import { computeVirtualWindow } from "../core/ui/virtual-window";
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
  const [rollingBack, setRollingBack] = useState(false);
  const [epochRows, setEpochRows] = useState<ContextEpochRow[]>([]);
  const [repairText, setRepairText] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measureTick, setMeasureTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef(new Map<string, number>());
  const observedRef = useRef(new Set<string>());
  const observersRef = useRef(new Map<string, ResizeObserver>());
  const itemRefsRef = useRef(new Map<string, (el: HTMLElement | null) => void>());
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

  /**
   * `context_epochs` 是派生索引：完整历史打开时从时间线投影一次，
   * 再读回来显示；表写失败不影响时间线/模型视图。
   */
  useEffect(() => {
    if (!open || timeline.length === 0 || !hasStoragePort()) {
      // 清掉上一个会话的派生索引计数，避免空会话显示别人的「检查点索引 N」
      setEpochRows((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void (async () => {
      await syncContextEpochs(sessionId, timeline);
      const rows = await listContextEpochs(sessionId);
      if (!cancelled) {
        setEpochRows((prev) => {
          if (prev.length === 0 && rows.length === 0) return prev;
          return prev.length === rows.length && prev.every((r, i) => r.id === rows[i]?.id && r.cutoff_message_id === rows[i]?.cutoff_message_id)
            ? prev
            : rows;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [open, sessionId, timeline]);

  useEffect(() => {
    if (!open) return;
    // 焦点放到关闭按钮；Esc/遮罩关闭与焦点归还由 useDismissableLayer 统一处理。
    const t = setTimeout(() => closeRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    return () => {
      for (const ro of observersRef.current.values()) ro.disconnect();
      observersRef.current.clear();
      observedRef.current.clear();
      itemRefsRef.current.clear();
      heightsRef.current.clear();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    // 打开/切换视图/新数据后贴到底部（最新消息），虚拟窗口随 scrollTop 更新。
    const h = el.clientHeight;
    if (h > 0 && h !== viewportHeight) setViewportHeight(h);
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [open, sessionId, view, timeline.length, modelMessages.length]);

  if (!open) return null;

  const messages = view === "model" ? modelMessages : timeline;
  void measureTick;
  const heights = messages.map((m) => {
    const measured = heightsRef.current.get(m.id);
    if (measured && measured > 0) return measured;
    const contentLen = typeof m.content === "string" ? m.content.length : 0;
    const reasoningLen = typeof m.reasoning === "string" ? m.reasoning.length : 0;
    return Math.max(56, Math.min(260, 44 + contentLen * 0.35 + reasoningLen * 0.1));
  });
  const virt = computeVirtualWindow(heights, scrollTop, viewportHeight, 4);
  const visibleMessages = messages.slice(virt.start, virt.end);
  const measureItem = (id: string) => {
    let cb = itemRefsRef.current.get(id);
    if (cb) return cb;
    cb = (el: HTMLElement | null) => {
      if (!el) {
        const ro = observersRef.current.get(id);
        ro?.disconnect();
        observersRef.current.delete(id);
        observedRef.current.delete(id);
        return;
      }
      const h = el.offsetHeight;
      if (h > 0 && Math.abs((heightsRef.current.get(id) ?? 0) - h) > 1) {
        heightsRef.current.set(id, h);
        setMeasureTick((v) => v + 1);
      }
      if (!observedRef.current.has(id)) {
        observedRef.current.add(id);
        if (typeof ResizeObserver !== "undefined") {
          const ro = new ResizeObserver(() => {
            const next = el.offsetHeight;
            if (next > 0 && Math.abs((heightsRef.current.get(id) ?? 0) - next) > 1) {
              heightsRef.current.set(id, next);
              setMeasureTick((v) => v + 1);
            }
          });
          ro.observe(el);
          observersRef.current.set(id, ro);
        }
      }
    };
    itemRefsRef.current.set(id, cb);
    return cb;
  };
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

  const rollback = async () => {
    setRollingBack(true);
    setRepairText(null);
    try {
      const preview = await rollbackSessionToClassicHidden(sessionId, { dryRun: true });
      if (!preview.epochId || preview.candidates === 0) {
        setRepairText("当前会话没有可回滚的检查点（或 cutoff 之前没有消息）。");
        return;
      }
      const ok = await confirmDialog(
        `回滚会把 cutoff 之前的 ${preview.candidates} 条消息写回 hidden（不删正文、不写墓碑），让旧版本按压缩后视图运行。继续？`,
      );
      if (!ok) return;
      const report = await rollbackSessionToClassicHidden(sessionId);
      setRepairText(`回滚完成：${report.hidden} 条已写回 hidden，${report.failed} 条失败。`);
      reload();
    } catch (e) {
      setRepairText(`回滚失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRollingBack(false);
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
            {epochRows.length > 0 ? ` · 检查点索引 ${epochRows.length}` : ""}
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
          <button
            className="context-history-close"
            disabled={rollingBack}
            onClick={rollback}
            title="一次性回滚：把 cutoff 之前的消息写回 hidden，供旧版本按压缩后视图运行"
          >
            {rollingBack ? "回滚中…" : "回滚到旧版"}
          </button>
          <span style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}>只读</span>
          <button ref={closeRef} className="context-history-close" onClick={onClose} aria-label="关闭完整历史">
            关闭
          </button>
        </div>

        <div
          ref={scrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{ overflow: "auto", padding: "12px 16px" }}
          data-virtual-total={messages.length}
          data-virtual-start={virt.start}
          data-virtual-end={virt.end}
        >
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
          {!loading && !error && virt.top > 0 && (
            <div aria-hidden="true" style={{ height: virt.top }} />
          )}
          {!loading && !error && visibleMessages.map((m) => {
            const marker = isCompactionMarker(m as never);
            return (
              <article
                key={m.id}
                ref={measureItem(m.id)}
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
          {!loading && !error && virt.bottom > 0 && (
            <div aria-hidden="true" style={{ height: virt.bottom }} />
          )}
        </div>
      </div>
    </div>
  );
}
