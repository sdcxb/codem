import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Plus, Square } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import "@xterm/xterm/css/xterm.css";

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(command, args);
}

interface TerminalPanelProps {
  cwd: string;
}

interface PtySession {
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  cwd: string;
}

const MAX_SESSIONS = 5;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function TerminalPanel({ cwd }: TerminalPanelProps) {
  const [sessions, setSessions] = useState<PtySession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<PtySession[]>([]);
  const cleanupTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Keep ref in sync
  sessionsRef.current = sessions;

  const createSession = useCallback(async () => {
    if (sessionsRef.current.length >= MAX_SESSIONS) return;
    if (!containerRef.current) return;

    const { listen } = (window as any).__TAURI__?.event || {};

    const term = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#f0f6fc",
        cursor: "#2f81f7",
        selectionBackground: "#2f81f740",
      },
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 14,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // Create a temporary div for this terminal
    const termDiv = document.createElement("div");
    termDiv.style.height = "100%";
    termDiv.style.width = "100%";
    containerRef.current.appendChild(termDiv);
    term.open(termDiv);
    fitAddon.fit();

    // Spawn PTY
    let ptyId: string;
    try {
      ptyId = await tauriInvoke("spawn_pty", { cwd });
    } catch (e: any) {
      term.write(`\x1b[31mFailed to spawn terminal: ${e.message}\x1b[0m\r\n`);
      return;
    }

    const session: PtySession = { id: ptyId, term, fitAddon, cwd };
    const newSessions = [...sessionsRef.current, session];
    setSessions(newSessions);
    setActiveId(ptyId);

    // Show only the active terminal div
    sessionsRef.current.forEach((s) => {
      const div = s.term.element?.parentElement;
      if (div) div.style.display = s.id === ptyId ? "block" : "none";
    });

    term.write(`\r\n🔗 Codem 终端 (PTY)\r\n`);
    term.write(`📁 ${cwd}\r\n\r\n`);

    // Listen for PTY output
    const unlisten = await listen("pty-output", (event: any) => {
      const payload = event.payload as { id: string; data: string };
      if (payload.id === ptyId) {
        term.write(payload.data);
      }
    });

    // Handle user input → write to PTY
    const disposable = term.onData((data) => {
      tauriInvoke("write_pty", { id: ptyId, data }).catch(() => {});
    });

    // Ctrl+C = copy only (no interrupt); Ctrl+Shift+C = interrupt
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown") {
        // Ctrl+V — paste
        if (event.ctrlKey && !event.shiftKey && event.key === "v") {
          navigator.clipboard.readText().then((text) => {
            if (text) {
              tauriInvoke("write_pty", { id: ptyId, data: text }).catch(() => {});
            }
          }).catch(() => {});
          return false;
        }
        // Ctrl+C — copy if selection exists, otherwise DO NOTHING (no interrupt)
        if (event.ctrlKey && !event.shiftKey && event.key === "c") {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
            term.clearSelection();
            return false; // Don't send Ctrl+C
          }
          return false; // No selection → don't send Ctrl+C either (prevents accidental interrupt)
        }
        // Ctrl+Shift+C — interrupt (send \x03 to PTY)
        if (event.ctrlKey && event.shiftKey && (event.key === "C" || event.key === "c")) {
          tauriInvoke("write_pty", { id: ptyId, data: "\x03" }).catch(() => {});
          return false;
        }
      }
      return true;
    });

    // Right-click: copy selection or paste
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {});
        term.clearSelection();
      } else {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            tauriInvoke("write_pty", { id: ptyId, data: text }).catch(() => {});
          }
        }).catch(() => {});
      }
    };
    term.element?.addEventListener("contextmenu", handleContextMenu);

    // Resize handling — 防抖 + rAF 避免 ResizeObserver loop 报错
    let resizeRafId: number | null = null;
    let lastCols = 0, lastRows = 0;
    const doResize = () => {
      resizeRafId = null;
      try {
        fitAddon.fit();
        const cols = term.cols;
        const rows = term.rows;
        // 仅在尺寸实际变化时才通知 PTY，避免多余调用
        if (cols !== lastCols || rows !== lastRows) {
          lastCols = cols;
          lastRows = rows;
          tauriInvoke("resize_pty", { id: ptyId, cols, rows }).catch(() => {});
        }
      } catch {}
    };
    const resizeObserver = new ResizeObserver(() => {
      // 用 rAF 防抖：将 fit 操作推迟到下一帧，避免同步布局抖动
      // 这解决了 "ResizeObserver loop completed with undelivered notifications" 报错
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(doResize);
    });
    if (term.element) {
      resizeObserver.observe(term.element);
    }

    // Reset TTL timer on activity
    const resetTtl = () => {
      const existing = cleanupTimers.current.get(ptyId);
      if (existing) clearTimeout(existing);
      cleanupTimers.current.set(
        ptyId,
        setTimeout(() => {
          closeSession(ptyId);
        }, SESSION_TTL_MS),
      );
    };
    term.onData(resetTtl);

    // Store cleanup functions on the session object
    (session as any)._cleanup = () => {
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      unlisten();
      disposable.dispose();
      resizeObserver.disconnect();
      term.element?.removeEventListener("contextmenu", handleContextMenu);
      const timer = cleanupTimers.current.get(ptyId);
      if (timer) clearTimeout(timer);
      cleanupTimers.current.delete(ptyId);
      term.dispose();
      termDiv.remove();
    };
  }, [cwd]);

  const closeSession = useCallback((id: string) => {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session) {
      (session as any)._cleanup?.();
      tauriInvoke("close_pty", { id }).catch(() => {});
    }
    const remaining = sessionsRef.current.filter((s) => s.id !== id);
    setSessions(remaining);
    if (activeId === id) {
      const next = remaining[0];
      if (next) {
        setActiveId(next.id);
        const div = next.term.element?.parentElement;
        if (div) div.style.display = "block";
      } else {
        setActiveId(null);
      }
    }
  }, [activeId]);

  const switchSession = useCallback((id: string) => {
    sessionsRef.current.forEach((s) => {
      const div = s.term.element?.parentElement;
      if (div) div.style.display = s.id === id ? "block" : "none";
    });
    setActiveId(id);
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session) {
      session.fitAddon.fit();
      tauriInvoke("resize_pty", { id, cols: session.term.cols, rows: session.term.rows }).catch(() => {});
      session.term.focus();
    }
  }, []);

  // Auto-create first session on mount
  useEffect(() => {
    if (sessions.length === 0) {
      createSession();
    }
    return () => {
      // Cleanup all sessions on unmount
      sessionsRef.current.forEach((s) => {
        (s as any)._cleanup?.();
        tauriInvoke("close_pty", { id: s.id }).catch(() => {});
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="terminal-panel">
      {/* Tab bar */}
      <div className="terminal-tab-bar">
        {sessions.map((s, i) => (
          <div
            key={s.id}
            className={"terminal-tab " + s.id === activeId ? "active" : ""}
            onClick={() => switchSession(s.id)}
          >
            <span className="terminal-tab-label">
              {`终端 ${i + 1}`}
            </span>
            <button
              className="terminal-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
            >
              <ActionIcons.close size={12} />
            </button>
          </div>
        ))}
        {sessions.length < MAX_SESSIONS && (
          <button className="terminal-tab-new" onClick={() => createSession()} title="新建终端">
            <Plus size={14} />
          </button>
        )}
        {/* Stop button — sends Ctrl+C to active PTY */}
        {activeSession && (
          <button
            className="terminal-stop-btn"
            onClick={() => {
              tauriInvoke("write_pty", { id: activeSession.id, data: "\x03" }).catch(() => {});
            }}
            title="停止当前进程 (Ctrl+Shift+C)"
          >
            <Square size={12} />
            <span>停止</span>
          </button>
        )}
      </div>

      {/* Terminal containers */}
      <div ref={containerRef} className="terminal-container-wrapper" />
    </div>
  );
}
