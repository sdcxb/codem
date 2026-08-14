/**
 * Terminal LLM 工具组
 *
 * Design (对标 DeepSeek Harness terminal tools):
 * - terminal_open: 在终端面板中打开一个新的 shell 会话
 * - terminal_send: 向终端发送输入
 * - terminal_signal: 发送信号 (Ctrl+C, Ctrl+D)
 * - terminal_close: 关闭终端会话
 *
 * 这些工具共享 PTY 会话，与 UI 中的终端面板互通。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";

// ========== Terminal Manager ==========

interface TerminalSession {
  id: string;
  cwd: string;
  active: boolean;
  createdAt: number;
}

class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  open(cwd: string): string {
    const id = `term-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    this.sessions.set(id, {
      id,
      cwd,
      active: true,
      createdAt: Date.now(),
    });
    return id;
  }

  send(id: string, input: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.active) return false;
    // In actual implementation, this would write to the PTY
    // For now, we dispatch a custom event that the TerminalPanel picks up
    window.dispatchEvent(new CustomEvent("codem-terminal-input", {
      detail: { id, input },
    }));
    return true;
  }

  signal(id: string, signal: "ctrl_c" | "ctrl_d" | "ctrl_z"): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.active) return false;
    const signalChar = signal === "ctrl_c" ? "\x03" : signal === "ctrl_d" ? "\x04" : "\x1a";
    window.dispatchEvent(new CustomEvent("codem-terminal-input", {
      detail: { id, input: signalChar },
    }));
    return true;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.active = false;
    this.sessions.delete(id);
    return true;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }
}

let terminalManager: TerminalManager | null = null;

function getTerminalManager(): TerminalManager {
  if (!terminalManager) {
    terminalManager = new TerminalManager();
  }
  return terminalManager;
}

// ========== Tool Definitions ==========

export function createTerminalOpenTool(): ToolDef {
  return {
    id: "terminal_open",
    description: "Open a new terminal session. Returns a terminal ID for use with terminal_send, terminal_signal, and terminal_close.",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory for the terminal" },
      },
      required: ["cwd"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const cwd = (args.cwd as string) || ctx.cwd;
      const id = getTerminalManager().open(cwd);
      return {
        title: "terminal_open",
        output: `Terminal session opened. ID: ${id}\nWorking directory: ${cwd}`,
      };
    },
  };
}

export function createTerminalSendTool(): ToolDef {
  return {
    id: "terminal_send",
    description: "Send input to a terminal session (like typing in the terminal).",
    parameters: {
      type: "object",
      properties: {
        terminal_id: { type: "string", description: "Terminal session ID from terminal_open" },
        input: { type: "string", description: "Text to send to the terminal" },
      },
      required: ["terminal_id", "input"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.terminal_id as string;
      const input = args.input as string;
      const success = getTerminalManager().send(id, input);
      return {
        title: "terminal_send",
        output: success ? `Sent ${input.length} chars to terminal ${id}` : `Error: Terminal ${id} not found or inactive`,
      };
    },
  };
}

export function createTerminalSignalTool(): ToolDef {
  return {
    id: "terminal_signal",
    description: "Send a signal to a terminal session (Ctrl+C, Ctrl+D, Ctrl+Z).",
    parameters: {
      type: "object",
      properties: {
        terminal_id: { type: "string", description: "Terminal session ID" },
        signal: { type: "string", enum: ["ctrl_c", "ctrl_d", "ctrl_z"], description: "Signal to send" },
      },
      required: ["terminal_id", "signal"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.terminal_id as string;
      const signal = args.signal as "ctrl_c" | "ctrl_d" | "ctrl_z";
      const success = getTerminalManager().signal(id, signal);
      return {
        title: "terminal_signal",
        output: success ? `Sent ${signal} to terminal ${id}` : `Error: Terminal ${id} not found or inactive`,
      };
    },
  };
}

export function createTerminalCloseTool(): ToolDef {
  return {
    id: "terminal_close",
    description: "Close a terminal session.",
    parameters: {
      type: "object",
      properties: {
        terminal_id: { type: "string", description: "Terminal session ID" },
      },
      required: ["terminal_id"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.terminal_id as string;
      const success = getTerminalManager().close(id);
      return {
        title: "terminal_close",
        output: success ? `Terminal ${id} closed` : `Error: Terminal ${id} not found`,
      };
    },
  };
}
