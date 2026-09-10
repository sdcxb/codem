/**
 * SideSessionPanel — 临时会话悬浮窗（B1，对标 EAC dsh-side-session / Codex side session）
 *
 * 页内 fixed 悬浮窗：基于当前主会话上下文（最近消息 + cwd）发起独立追问，
 * 回答不写回主会话 store/DB。入口：header 按钮唤起（ChatPanel 集成）。
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { X, Send, MessageSquareText, LoaderCircle, Sparkles } from "lucide-react";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";
import { collectSessionContext, buildSideMessages, extractStreamDelta, formatSideError, genTurnId, type SideSessionTurn } from "../core/side-session/side-session";
import { getLLMEngine } from "../core/llm";

interface SideSessionPanelProps {
  onClose: () => void;
  /** 外部控制收起（header 按钮） */
  open?: boolean;
}

export function SideSessionPanel({ onClose, open = true }: SideSessionPanelProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const messages = useAppStore((s) => s.messages);
  const currentSession = useProjectStore((s) => s.currentSession);
  const currentProject = useProjectStore((s) => s.currentProject);

  const [turns, setTurns] = useState<SideSessionTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 拖拽（标题栏）
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const panel = (e.currentTarget as HTMLElement).parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      setPos({ x: Math.max(0, ev.clientX - dragRef.current.dx), y: Math.max(0, ev.clientY - dragRef.current.dy) });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    // 收集上下文（当前主会话消息窗口）
    const ctx = collectSessionContext(
      messages,
      currentSession?.title || (zh ? "当前会话" : "current session"),
      currentProject?.path || null,
    );
    const turnId = genTurnId();
    const turn: SideSessionTurn = { id: turnId, question: q, answer: "", createdAt: Date.now(), streaming: true };
    setTurns((prev) => [...prev, turn]);
    setQuestion("");
    setErr(null);
    setBusy(true);

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const engine = getLLMEngine();
      const providerId = engine.getDefaultProvider();
      const model = engine.getDefaultModel();
      const provider = engine.providers.get(providerId);
      if (!provider) throw new Error(zh ? "模型服务不可用" : "LLM provider unavailable");
      const llmMessages = buildSideMessages(ctx, q);
      let acc = "";
      // 流式回答（增量写入 turn.answer）— StreamEvent 判别联合：text_delta 携带增量文本
      const gen = provider.stream({ model, messages: llmMessages, abortSignal: abort.signal, stream: true });
      for await (const ev of gen) {
        const chunk = extractStreamDelta(ev);
        if (chunk) {
          acc += chunk;
          const tId = turnId;
          setTurns((prev) => prev.map((t) => (t.id === tId ? { ...t, answer: acc } : t)));
        }
      }
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)));
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)));
      } else {
        const msg = formatSideError(e);
        setErr(msg);
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, streaming: false, error: msg } : t)));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [question, busy, messages, currentSession?.title, currentProject?.path, zh]);

  if (!open) return null;

  return (
    <div
      className="side-session-panel floating-overlay-panel"
      style={{
        position: "fixed",
        left: pos ? pos.x : undefined,
        top: pos ? pos.y : undefined,
        right: pos ? undefined : 16,
        bottom: pos ? undefined : 150,
        width: 380, height: 480, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 180px)",
        display: "flex", flexDirection: "column",
        background: "var(--dropdown-bg, #1e222d)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "0 16px 48px var(--shadow-color)",
        zIndex: "var(--z-floating)",
        overflow: "hidden",
      }}
    >
      {/* Header — draggable */}
      <div
        onPointerDown={handlePointerDown}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", cursor: "grab", userSelect: "none", borderBottom: "1px solid var(--border-primary, rgba(0,0,0,.08))" }}
      >
        <MessageSquareText size={14} style={{ color: "var(--accent)" }} />
        <strong style={{ fontSize: 'var(--fs-sm)', flex: 1 }}>{zh ? "临时会话" : "Side Session"}</strong>
        <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
          <Sparkles size={12} />
          {zh ? "不污染主会话" : "won't touch main chat"}
        </span>
        <button className="toolbar-btn" aria-label={zh ? "关闭" : "Close"} onClick={onClose} title={zh ? "关闭" : "Close"}>
          <X size={14} />
        </button>
      </div>

      {/* Turns */}
      <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "grid", gap: 10, alignContent: "start" }}>
        {turns.length === 0 && (
          <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.7, padding: "8px 2px" }}>
            {zh
              ? "基于当前会话上下文提问（不会写入主会话）：\n\n· 上下文 = 最近会话消息 + 项目目录\n· 回答走当前模型流式输出\n· 关闭窗口即丢弃本次追问"
              : "Ask based on the current session context (nothing is written back to the main chat):\n\n· Context = recent messages + project dir\n· Streamed answer with the current model\n· Closing this window discards the thread"}
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-primary)", background: "color-mix(in srgb, var(--user-bg, #2a3140) 60%, transparent)", padding: "8px 10px", borderRadius: "var(--radius-md)", justifySelf: "flex-end", maxWidth: "88%" }}>
              {t.question}
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", background: "var(--bg-secondary, #232834)", padding: "8px 10px", borderRadius: "var(--radius-md)", maxWidth: "94%", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {t.streaming && !t.answer ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><LoaderCircle size={12} className="spin" /> {zh ? "思考中…" : "thinking…"}</span>
              ) : t.answer || (zh ? "(空回复)" : "(empty)")}
              {t.error && (
                <div style={{ color: "var(--error, #e5484d)", marginTop: 6, fontSize: 'var(--fs-xs)' }}>{t.error}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border-primary, rgba(0,0,0,.08))", display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
          }}
          rows={2}
          placeholder={zh ? "追问（Enter 发送，Shift+Enter 换行）…" : "Follow-up (Enter to ask)…"}
          style={{ flex: 1, background: "var(--bg-tertiary, #2a2f3a)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius)", padding: "6px 8px", fontSize: 'var(--fs-sm)', resize: "none", outline: "none" }}
        />
        <button
          className="toolbar-btn"
          aria-label={zh ? "发送" : "Send"}
          onClick={ask}
          disabled={busy || !question.trim()}
          title={zh ? "发送" : "Send"}
          style={{ opacity: busy || !question.trim() ? 0.5 : 1 }}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
