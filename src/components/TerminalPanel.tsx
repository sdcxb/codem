import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Plus, Square } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { handleTerminalKeyEvent } from "../core/llm/tools/terminal-key-handler";
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
  /**
   * P1-7：卸载标记。
   *
   * 原实现的清理链有两个洞：
   *   ① `createSession` 是 async（`spawn_pty` 与两次 `listen` 都要 await）。面板在
   *      await 期间被卸载时，卸载路径遍历的是 `sessionsRef.current` —— 而**故意不上报**
   *      的资源（PTY 进程 id、两个 unlisten、xterm 实例、ResizeObserver）都还没进这个数组：
   *      这一轮的"卸载清理"什么也没清，随后异步创建**接着完成**，于是永久泄漏：
   *      PTY 子进程 + 2 个 Tauri 全局监听（每次新建终端都再叠 2 个，回调还写到已销毁的
   *      term 上）+ xterm 实例 + ResizeObserver + 一个 30 分钟的 TTL 定时器。
   *   ② 清理本身不幂等：`_cleanup` 可以被 closeSession 与卸载各调用一次。
   * 现在：卸载即置位 disposedRef；每个 await 之后都检查一次，发现已卸载就**立刻自我清理**
   * （kill PTY + unlisten + dispose xterm/ResizeObserver/定时器 + 移除容器 div）；
   * `_cleanup` 用 `_disposed` 标记做成幂等（重复调用安全）。
   */
  const disposedRef = useRef(false);

  // Keep ref in sync
  sessionsRef.current = sessions;

  const createSession = useCallback(async () => {
    if (disposedRef.current) return;
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

    // 本轮创建过程中拿到的可释放资源（卸载/失败时统一释放）
    // ⚠️ 释放必须**逐项独立**且**可重入**：
    //   - 逐项：任何一项抛错都不能让后面的项被跳过（否则"清了一半"）；
    //   - 可重入：卸载可能发生在任意一个 await 之间，已经建立好的监听/实例必须
    //     在它自己的 await 落地时**再释放一次** —— 只看一个 cleanupDone 布尔量会漏掉
    //     "卸载先跑（此时 unlisten 还是 null）、监听随后才建立"这一个顺序。
    let unlisten: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let disposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeRafId: number | null = null;
    let unlistenBound = false;
    let unlistenExitBound = false;
    let disposableBound = false;
    let observerBound = false;
    let termDisposed = false;
    const releaseAll = () => {
      if (resizeRafId !== null) {
        try { cancelAnimationFrame(resizeRafId); } catch { /* ignore */ }
        resizeRafId = null;
      }
      if (unlistenBound && unlisten) {
        unlistenBound = false;
        try { unlisten(); } catch { /* ignore */ }
      }
      if (unlistenExitBound && unlistenExit) {
        unlistenExitBound = false;
        try { unlistenExit(); } catch { /* ignore */ }
      }
      if (disposableBound && disposable) {
        disposableBound = false;
        try { disposable.dispose(); } catch { /* ignore */ }
      }
      if (observerBound && resizeObserver) {
        observerBound = false;
        try { resizeObserver.disconnect(); } catch { /* ignore */ }
      }
      if (!termDisposed) {
        termDisposed = true;
        try { term.dispose(); } catch { /* ignore */ }
      }
      try { termDiv.remove(); } catch { /* ignore */ }
    };

    // Spawn PTY
    let ptyId: string;
    try {
      ptyId = await tauriInvoke("spawn_pty", { cwd });
    } catch (e: any) {
      // FIX: spawn 失败时清理已创建的终端 DOM/实例，避免容器残留空终端 div
      // （此前只写错误文本就 return，termDiv 永远留在容器里，也无法被关闭）。
      term.write(`\x1b[31mFailed to spawn terminal: ${e.message}\x1b[0m\r\n`);
      releaseAll();
      return;
    }

    // 在 await 期间被卸载 → 立刻回收刚拿到的 PTY（否则子进程活到面板之外）
    if (disposedRef.current) {
      try { tauriInvoke("close_pty", { id: ptyId }).catch(() => {}); } catch { /* ignore */ }
      releaseAll();
      return;
    }

    const session: PtySession = { id: ptyId, term, fitAddon, cwd };
    (session as any)._disposed = false;
    // 先登记再继续 await：这样卸载路径**一定**能遍历到它
    sessionsRef.current = [...sessionsRef.current, session];
    const newSessions = sessionsRef.current;
    setSessions(newSessions);
    setActiveId(ptyId);

    // Show only the active terminal div
    sessionsRef.current.forEach((s) => {
      const div = s.term.element?.parentElement;
      if (div) div.style.display = s.id === ptyId ? "block" : "none";
    });

    term.write(`\r\n🔗 Codem 终端 (PTY)\r\n`);
    term.write(`📁 ${cwd}\r\n\r\n`);

    /** 监听建立失败 / 卸载后完成 → 回收 PTY 并释放已建立的资源。 */
    const abortWithPty = () => {
      releaseAll();
      try { tauriInvoke("close_pty", { id: ptyId }).catch(() => {}); } catch { /* ignore */ }
    };

    // Listen for PTY output
    try {
      unlisten = await listen("pty-output", (event: any) => {
        if ((session as any)._disposed) return;
        const payload = event.payload as { id: string; data: string };
        if (payload.id === ptyId) {
          term.write(payload.data);
        }
      });
      unlistenBound = true;
    } catch (e) {
      // 监听建立失败：PTY 已经启动，必须回收（否则子进程活到 30 分钟 TTL 之外都没人管）
      term.write(`\x1b[31mFailed to attach terminal listeners: ${(e as Error)?.message}\x1b[0m\r\n`);
      abortWithPty();
      return;
    }
    if (disposedRef.current) {
      // 卸载先跑、监听随后才建立 → 这一项必须在这里补释放（否则监听永久留在 process 上）
      abortWithPty();
      return;
    }

    // Listen for PTY exit (shell closed / pipe broken / crash) — 主动关闭由
    // closeSession 处理（_cleanup + close_pty），这里只处理"意外结束"。
    // FIX: 之前输出线程静默退出，前端不知会话已结束 —— 僵尸会话挂到 TTL。
    try {
      unlistenExit = await listen("pty-exit", (event: any) => {
        if ((session as any)._disposed) return;
        const payload = event.payload as { id: string; data: string };
        if (payload.id !== ptyId) return;
        const s = sessionsRef.current.find((x) => x.id === ptyId);
        if (!s || (s as any)._closing) return; // 主动关闭中 — 忽略
        term.write(`\r\n\x1b[90m[进程已退出${payload.data ? ` (${payload.data})` : ""} — 可关闭此标签页]\x1b[0m\r\n`);
      });
      unlistenExitBound = true;
    } catch (e) {
      term.write(`\x1b[31mFailed to attach terminal listeners: ${(e as Error)?.message}\x1b[0m\r\n`);
      abortWithPty();
      return;
    }
    if (disposedRef.current) {
      abortWithPty();
      return;
    }

    // Handle user input → write to PTY
    disposable = term.onData((data) => {
      tauriInvoke("write_pty", { id: ptyId, data }).catch(() => {});
    });
    disposableBound = true;

    // Ctrl+C = copy only (no interrupt); Ctrl+Shift+C = interrupt
    term.attachCustomKeyEventHandler((event) => {
      return handleTerminalKeyEvent(event, {
        getSelection: () => term.getSelection(),
        clearSelection: () => term.clearSelection(),
        writeClipboard: (text) => navigator.clipboard.writeText(text).catch(() => {}),
        readClipboard: () => navigator.clipboard.readText(),
        writeToPty: (data) => { tauriInvoke("write_pty", { id: ptyId, data }).catch(() => {}); },
      });
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
    resizeObserver = new ResizeObserver(() => {
      // 用 rAF 防抖：将 fit 操作推迟到下一帧，避免同步布局抖动
      // 这解决了 "ResizeObserver loop completed with undelivered notifications" 报错
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(doResize);
    });
    if (term.element) {
      resizeObserver.observe(term.element);
      observerBound = true;
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

    // Store cleanup functions on the session object（幂等：重复调用只生效一次）
    (session as any)._cleanup = () => {
      if ((session as any)._disposed) return;
      (session as any)._disposed = true;
      releaseAll();
      term.element?.removeEventListener("contextmenu", handleContextMenu);
      const timer = cleanupTimers.current.get(ptyId);
      if (timer) clearTimeout(timer);
      cleanupTimers.current.delete(ptyId);
    };

    // 卸载路径可能在本轮 await 期间就被触发（那时 _cleanup 还没装上），
    // 这里补一次检查：装上清理函数后若已卸载，立刻执行。
    if (disposedRef.current) {
      (session as any)._cleanup();
      try { tauriInvoke("close_pty", { id: ptyId }).catch(() => {}); } catch { /* ignore */ }
    }
  }, [cwd]);

  const closeSession = useCallback((id: string) => {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session) {
      // 标记主动关闭 — pty-exit 事件到达时忽略（避免与手动清理竞争）
      (session as any)._closing = true;
      (session as any)._cleanup?.();
      tauriInvoke("close_pty", { id }).catch(() => {});
    }
    const remaining = sessionsRef.current.filter((s) => s.id !== id);
    sessionsRef.current = remaining;
    setSessions(remaining);
    // 函数式更新：不依赖闭包里的 activeId（TTL 定时器回调可能携带过期值）
    setActiveId((prevActive) => {
      if (prevActive !== id) return prevActive;
      const next = remaining[0];
      if (next) {
        const div = next.term.element?.parentElement;
        if (div) div.style.display = "block";
        return next.id;
      }
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    disposedRef.current = false;
    if (sessions.length === 0) {
      createSession();
    }
    return () => {
      // P1-7：先置卸载标记，让"卸载后才完成"的异步创建自我清理（见 createSession）
      disposedRef.current = true;
      // Cleanup all sessions on unmount（_cleanup 幂等，重复卸载安全）
      sessionsRef.current.forEach((s) => {
        (s as any)._cleanup?.();
        tauriInvoke("close_pty", { id: s.id }).catch(() => {});
      });
      sessionsRef.current = [];
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
            className={"terminal-tab" + (s.id === activeId ? " active" : "")}
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
