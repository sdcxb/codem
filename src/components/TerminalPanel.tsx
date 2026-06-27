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
      term.write(`📁 ${cwd}\r\n\r\n`);

      let currentLine = "";

      const disposable = term.onData((data) => {
        if (data === "\r") {
          // Enter pressed
          if (currentLine.trim()) {
            executeCommand(currentLine.trim(), term);
          }
          currentLine = "";
        } else if (data === "\x7f") {
          // Backspace
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            term.write("\b \b");
          }
        } else if (data >= " ") {
          currentLine += data;
          term.write(data);
        }
      });

      return () => {
        disposable.dispose();
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
