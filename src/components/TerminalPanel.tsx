import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const isTauri = () => !!(window as any).__TAURI__;

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(command, args);
}

interface TerminalPanelProps {
  cwd: string;
}

export function TerminalPanel({ cwd }: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

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
    term.open(terminalRef.current);
    fitAddon.fit();
    termRef.current = term;

    if (isTauri()) {
      // Tauri mode - use execute_command
      term.write("\r\n🔗 Codem 终端 (Tauri 模式)\r\n");
      term.write(`📁 ${cwd}\r\n`);
      term.write(`💡 Ctrl+V 粘贴 | Ctrl+C 复制选区 | 右键粘贴\r\n\r\n`);
      term.write(`\x1b[36m${cwd}>\x1b[0m `);

      let currentLine = "";
      let isExecuting = false;

      // Handle Ctrl+V (paste) and Ctrl+C (copy selection)
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown") {
          // Ctrl+V — paste from clipboard
          if (event.ctrlKey && event.key === "v") {
            navigator.clipboard.readText().then((text) => {
              if (text && !isExecuting) {
                // Replace newlines with spaces for single-line input
                const pasteText = text.replace(/[\r\n]+/g, " ");
                currentLine += pasteText;
                term.write(pasteText);
              }
            }).catch(() => {});
            return false; // Prevent default
          }
          // Ctrl+C — copy selection if text is selected, otherwise allow default
          if (event.ctrlKey && event.key === "c") {
            const selection = term.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection).catch(() => {});
              term.clearSelection();
              return false; // Prevent default — don't send Ctrl+C signal
            }
          }
        }
        return true; // Allow default for all other keys
      });

      const disposable = term.onData((data) => {
        if (isExecuting) return; // Ignore input while command is running
        if (data === "\r") {
          // Enter pressed
          if (currentLine.trim()) {
            isExecuting = true;
            executeCommand(currentLine.trim(), term).finally(() => {
              isExecuting = false;
              currentLine = "";
            });
          } else {
            term.write(`\r\n\x1b[36m${cwd}>\x1b[0m `);
          }
          currentLine = "";
        } else if (data === "\x7f") {
          // Backspace
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            term.write("\b \b");
          }
        } else if (data === "\x03") {
          // Ctrl+C signal (no selection) — cancel current line
          if (currentLine.length > 0) {
            term.write("^C");
            currentLine = "";
          }
          term.write(`\r\n\x1b[36m${cwd}>\x1b[0m `);
        } else if (data >= " ") {
          currentLine += data;
          term.write(data);
        }
      });

      // Right-click paste
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          // If there's a selection, copy it
          navigator.clipboard.writeText(selection).catch(() => {});
          term.clearSelection();
        } else {
          // No selection — paste from clipboard
          navigator.clipboard.readText().then((text) => {
            if (text && !isExecuting) {
              const pasteText = text.replace(/[\r\n]+/g, " ");
              currentLine += pasteText;
              term.write(pasteText);
            }
          }).catch(() => {});
        }
      };
      terminalRef.current.addEventListener("contextmenu", handleContextMenu);

      return () => {
        disposable.dispose();
        terminalRef.current?.removeEventListener("contextmenu", handleContextMenu);
        term.dispose();
      };
    } else {
      // WebSocket mode
      let ws: WebSocket | null = null;
      let reconnectTimeout: ReturnType<typeof setTimeout>;

      const connectTerminal = () => {
        ws = new WebSocket("ws://localhost:3002");

        ws.onopen = () => {
          ws?.send(JSON.stringify({ type: "terminal:start", cwd }));
          term.write("\r\n🔗 已连接到 Codem 终端\r\n");
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "terminal:data") {
              term.write(msg.data);
            }
          } catch {}
        };

        ws.onclose = () => {
          term.write("\r\n⚠️ 连接断开，3秒后重连...\r\n");
          reconnectTimeout = setTimeout(connectTerminal, 3000);
        };

        ws.onerror = () => {};
      };

      connectTerminal();

      // Handle Ctrl+V (paste) and Ctrl+C (copy selection) for WebSocket mode too
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown") {
          if (event.ctrlKey && event.key === "v") {
            navigator.clipboard.readText().then((text) => {
              if (text && ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "terminal:input", data: text }));
              }
            }).catch(() => {});
            return false;
          }
          if (event.ctrlKey && event.key === "c") {
            const selection = term.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection).catch(() => {});
              term.clearSelection();
              return false;
            }
          }
        }
        return true;
      });

      const disposable = term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "terminal:input", data }));
        }
      });

      const resizeDisposable = term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "terminal:resize", cols, rows }));
        }
      });

      const handleResize = () => fitAddon.fit();
      window.addEventListener("resize", handleResize);

      return () => {
        disposable.dispose();
        resizeDisposable.dispose();
        clearTimeout(reconnectTimeout);
        ws?.close();
        term.dispose();
        window.removeEventListener("resize", handleResize);
      };
    }
  }, [cwd]);

  async function executeCommand(command: string, term: Terminal) {
    term.write("\r\n");
    try {
      const result = await tauriInvoke("execute_command", { command, cwd });
      if (result.stdout) term.write(result.stdout);
      if (result.stderr) term.write(`\x1b[31m${result.stderr}\x1b[0m`);
    } catch (error: any) {
      term.write(`\x1b[31mError: ${error.message}\x1b[0m`);
    }
    term.write(`\r\n\x1b[36m${cwd}>\x1b[0m `);
  }

  return <div ref={terminalRef} className="terminal-container" />;
}
