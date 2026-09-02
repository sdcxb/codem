/**
 * Terminal LLM 工具组 (对标 DeepSeek Harness dsh-tool-terminal)
 *
 * 六个模型面向工具：
 * - terminal_open:    创建真实 PTY 会话 (spawn_pty)
 * - terminal_send:    发送文本并等待就绪 (write_pty + 静默窗口)
 * - terminal_read:    从保留的 scrollback 分页读取
 * - terminal_signal:  向前台进程组发送控制信号
 * - terminal_close:   关闭会话并清理 (close_pty)
 * - terminal_list:    列出当前活跃会话
 *
 * 与 UI 终端面板 (TerminalPanel) 共享同一 Rust PTY 后端 (portable-pty)，
 * 会话 ID 即 Rust 返回的 pty-uuid，LLM 工具与人工交互均落到同一真实 shell。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";

// ========== 常量 (对齐 dsh-terminal-bash 默认配置量级) ==========

/** 单会话保留的 scrollback 最大行数。 */
const MAX_SCROLLBACK_LINES = 10000;
/** terminal_read 单页默认行数。 */
const DEFAULT_READ_COUNT = 100;
/** terminal_send 静默判定窗口 (ms)：此窗口内无新输出视为已就绪。 */
const SEND_SILENCE_MS = 400;
/** terminal_send 最大等待时间 (ms)。 */
const SEND_MAX_WAIT_MS = 8000;
/** terminal_send 轮询间隔 (ms)。 */
const SEND_POLL_MS = 50;
/** 单次 send 返回的最大字节数（超出截断）。 */
const MAX_VIEWPORT_CHARS = 262144;

// ========== 会话模型 ==========

export interface TerminalSessionView {
  sessionId: string;
  name?: string;
  type: string;
  pid?: number;
  status: { kind: "running" } | { kind: "exited"; exitCode: number | null; signal: string | null };
}

interface TerminalSession {
  id: string;
  name?: string;
  cwd: string;
  active: boolean;
  createdAt: number;
  /** 增量输出缓冲：自上次 send/read 消费后累积，用于 send 返回 viewport。 */
  pendingOutput: string;
  /** 完整 scrollback（按行）。 */
  lines: string[];
  /** 最近一次被 send 消费的 scrollback 行数，用于计算增量。 */
  lastConsumedLineCount: number;
  unlisten?: () => void;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

interface PtyBackgroundJob {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "killed" | "error";
  stdout: string;
  stderr: string;
  startedAt: number;
  completedAt?: number;
  waitReason?: "inferred_idle" | "timeout" | "session_exit";
}

// ========== Tauri 访问 ==========

function tauriCore(): { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> } | null {
  try {
    const tauri = (window as any).__TAURI__;
    return tauri?.core ?? null;
  } catch {
    return null;
  }
}

function tauriEvent(): { listen: (event: string, cb: (e: any) => void) => Promise<() => void> } | null {
  try {
    const tauri = (window as any).__TAURI__;
    return tauri?.event ?? null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== Terminal Manager ==========

class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  async open(cwd: string, name?: string): Promise<TerminalSessionView> {
    const core = tauriCore();
    if (!core) {
      throw new Error("terminal tools require the Tauri runtime (spawn_pty unavailable)");
    }
    const id: string = await core.invoke("spawn_pty", { cwd });

    const session: TerminalSession = {
      id,
      name,
      cwd,
      active: true,
      createdAt: Date.now(),
      pendingOutput: "",
      lines: [],
      lastConsumedLineCount: 0,
      exited: false,
      exitCode: null,
      exitSignal: null,
    };

    // 注册 pty-output 监听：累积 scrollback 与增量输出
    const eventApi = tauriEvent();
    if (eventApi) {
      const unlisten = await eventApi.listen("pty-output", (event: any) => {
        const payload = event?.payload as { id: string; data: string } | undefined;
        if (!payload || payload.id !== id) return;
        const s = this.sessions.get(id);
        if (!s) return;
        s.pendingOutput += payload.data;
        s.lines.push(...payload.data.split("\n"));
        if (s.lines.length > MAX_SCROLLBACK_LINES) {
          s.lines.splice(0, s.lines.length - MAX_SCROLLBACK_LINES);
        }
      });
      session.unlisten = unlisten;
    }

    this.sessions.set(id, session);
    return this.snapshot(session);
  }

  private snapshot(session: TerminalSession): TerminalSessionView {
    return {
      sessionId: session.id,
      ...(session.name !== undefined ? { name: session.name } : {}),
      type: "shell",
      status: session.exited
        ? { kind: "exited", exitCode: session.exitCode, signal: session.exitSignal }
        : { kind: "running" },
    };
  }

  /**
   * 发送文本到会话。submit=true 时追加 Enter (\r)。
   * 写入后等待静默窗口，返回增量 viewport 与 waitReason。
   * 如果写入失败（会话已退出 / 不存在），返回 session_exit。
   */
  async send(id: string, input: string, submit = true): Promise<{
    viewport: string;
    waitReason: "inferred_idle" | "timeout" | "session_exit";
    sessionStatus: TerminalSessionView["status"];
    truncated: boolean;
  }> {
    const session = this.sessions.get(id);
    if (!session || !session.active) {
      return {
        viewport: "",
        waitReason: "session_exit",
        sessionStatus: { kind: "exited", exitCode: null, signal: null },
        truncated: false,
      };
    }

    const core = tauriCore();
    if (!core) {
      throw new Error("terminal tools require the Tauri runtime (write_pty unavailable)");
    }

    // 记录写入前已消费的 scrollback 行数，写入后的增量即本次输出。
    const beforeLineCount = session.lastConsumedLineCount;
    const data = submit ? `${input}\r` : input;
    try {
      await core.invoke("write_pty", { id, data });
    } catch {
      session.exited = true;
      return {
        viewport: "",
        waitReason: "session_exit",
        sessionStatus: { kind: "exited", exitCode: null, signal: null },
        truncated: false,
      };
    }

    // 静默窗口：等待输出停止增长（或达到最大等待时间）
    const startedAt = Date.now();
    let lastPendingLength = session.pendingOutput.length;
    while (Date.now() - startedAt < SEND_MAX_WAIT_MS) {
      await delay(SEND_POLL_MS);
      const currentLength = session.pendingOutput.length;
      if (currentLength > lastPendingLength) {
        // 有新输出，重置静默计时
        lastPendingLength = currentLength;
        continue;
      }
      if (Date.now() - startedAt >= SEND_SILENCE_MS) {
        break;
      }
    }

    // 从 scrollback 取增量（按行），避免 pendingOutput 的字节与行计数不一致
    const deltaLines = session.lines.slice(beforeLineCount);
    session.lastConsumedLineCount = session.lines.length;
    const delta = deltaLines.join("\n");
    // 消费增量后清空 pending 缓冲（其内容已并入 lines）
    session.pendingOutput = "";

    let viewport = delta;
    let truncated = false;
    if (viewport.length > MAX_VIEWPORT_CHARS) {
      viewport = `${viewport.slice(0, MAX_VIEWPORT_CHARS)}\n[output truncated]`;
      truncated = true;
    }

    const waitReason: "inferred_idle" | "timeout" = viewport.length > 0 ? "inferred_idle" : "timeout";
    return {
      viewport,
      waitReason,
      sessionStatus: this.snapshot(session).status,
      truncated,
    };
  }

  /** 分页读取保留的 scrollback。offset 为从最新行向前的偏移，count 为页行数。 */
  read(id: string, offset = 0, count = DEFAULT_READ_COUNT): {
    text: string;
    totalLines: number;
    lineBegin: number;
    lineEnd: number;
    truncated: boolean;
  } {
    const session = this.sessions.get(id);
    if (!session) {
      return { text: "", totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false };
    }
    const lines = session.lines;
    const total = lines.length;
    const end = Math.max(0, total - offset);
    const begin = Math.max(0, end - count);
    const page = lines.slice(begin, end);
    let text = page.join("\n");
    let truncated = false;
    if (text.length > MAX_VIEWPORT_CHARS) {
      text = `${text.slice(0, MAX_VIEWPORT_CHARS)}\n[output truncated]`;
      truncated = true;
    }
    return {
      text,
      totalLines: total,
      lineBegin: begin,
      lineEnd: end,
      truncated,
    };
  }

  /** 向前台进程组发送控制信号。返回目标信号与是否送达。 */
  async signal(id: string, signal: string): Promise<{ delivered: boolean; target: string }> {
    const session = this.sessions.get(id);
    if (!session || !session.active) {
      throw new Error(`terminal session not found or inactive: ${id}`);
    }
    const core = tauriCore();
    if (!core) {
      throw new Error("terminal tools require the Tauri runtime (write_pty unavailable)");
    }

    const char = this.signalChar(signal);
    if (char === null) {
      throw new Error(`unsupported signal: ${signal}`);
    }
    try {
      await core.invoke("write_pty", { id, data: char });
    } catch {
      session.exited = true;
      throw new Error(`terminal session has exited: ${id}`);
    }
    return { delivered: true, target: signal };
  }

  private signalChar(signal: string): string | null {
    switch (signal) {
      case "ctrl_c":
      case "SIGINT":
        return "\x03";
      case "ctrl_d":
        return "\x04";
      case "ctrl_z":
      case "SIGTSTP":
        return "\x1a";
      default:
        return null;
    }
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.active = false;
    session.exited = true;
    session.unlisten?.();
    const core = tauriCore();
    if (core) {
      try {
        await core.invoke("close_pty", { id });
      } catch {
        // 后端会话已不存在时视为已清理
      }
    }
    this.sessions.delete(id);
    return true;
  }

  list(): TerminalSessionView[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.active)
      .map((s) => this.snapshot(s));
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  // ========== 后台发送 (run_in_background) ==========

  private backgroundJobs = new Map<string, PtyBackgroundJob>();

  /**
   * 后台发送：立即返回 jobId，在后台等待静默窗口并收集输出。
   * 结果可通过 getBackgroundJob / job_output 读取，可用 killBackgroundJob 终止。
   */
  async sendBackground(id: string, input: string, submit = true): Promise<string> {
    const session = this.sessions.get(id);
    if (!session || !session.active) {
      throw new Error(`terminal session not found or inactive: ${id}`);
    }
    const core = tauriCore();
    if (!core) {
      throw new Error("terminal tools require the Tauri runtime (write_pty unavailable)");
    }

    const jobId = `pty-job-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const job: PtyBackgroundJob = {
      id: jobId,
      sessionId: id,
      status: "running",
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
    };
    this.backgroundJobs.set(jobId, job);

    const data = submit ? `${input}\r` : input;
    try {
      await core.invoke("write_pty", { id, data });
    } catch {
      session.exited = true;
      job.status = "error";
      job.stderr = "terminal session has exited";
      job.completedAt = Date.now();
      return jobId;
    }

    // 后台等待静默窗口（不阻塞模型调用）
    const beforeLineCount = session.lastConsumedLineCount;
    void (async () => {
      const startedAt = Date.now();
      let lastPendingLength = session.pendingOutput.length;
      while (Date.now() - startedAt < SEND_MAX_WAIT_MS) {
        await delay(SEND_POLL_MS);
        const currentLength = session.pendingOutput.length;
        if (currentLength > lastPendingLength) {
          lastPendingLength = currentLength;
          continue;
        }
        if (Date.now() - startedAt >= SEND_SILENCE_MS) break;
      }
      const deltaLines = session.lines.slice(beforeLineCount);
      session.lastConsumedLineCount = session.lines.length;
      const delta = deltaLines.join("\n");
      session.pendingOutput = "";
      if (job.status === "killed") return;
      job.stdout = delta;
      job.waitReason = delta.length > 0 ? "inferred_idle" : "timeout";
      job.status = "completed";
      job.completedAt = Date.now();
    })();

    return jobId;
  }

  getBackgroundJob(jobId: string): {
    id: string;
    sessionId: string;
    status: string;
    stdout: string;
    stderr: string;
    startedAt: number;
    completedAt?: number;
    waitReason?: string;
  } | undefined {
    const job = this.backgroundJobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  listBackgroundJobs(): Array<{
    id: string;
    sessionId: string;
    status: string;
    startedAt: number;
    completedAt?: number;
  }> {
    return Array.from(this.backgroundJobs.values()).map(({ id, sessionId, status, startedAt, completedAt }) => ({
      id,
      sessionId,
      status,
      startedAt,
      completedAt,
    }));
  }

  async killBackgroundJob(jobId: string): Promise<boolean> {
    const job = this.backgroundJobs.get(jobId);
    if (!job) return false;
    if (job.status === "running") {
      // 向会话前台发送 SIGINT (\x03)，对齐 dsh job_kill 语义
      try {
        await this.signal(job.sessionId, "SIGINT");
      } catch {
        // 会话已退出时忽略
      }
      job.status = "killed";
      job.completedAt = Date.now();
    }
    return true;
  }

  /** 测试辅助：重置单例。 */
  resetForTest(): void {
    for (const s of this.sessions.values()) {
      s.unlisten?.();
    }
    this.sessions.clear();
  }
}

let terminalManager: TerminalManager | null = null;

function getTerminalManager(): TerminalManager {
  if (!terminalManager) {
    terminalManager = new TerminalManager();
  }
  return terminalManager;
}

// ========== 工具定义 ==========

export function createTerminalOpenTool(): ToolDef {
  return {
    id: "terminal_open",
    guidance: "Use terminal_open to create a persistent, owner-isolated terminal session for interactive commands. Use bash for one-shot commands instead. Track every terminal session id and close sessions that no longer matter.",
    description: "Open a new persistent terminal (PTY) session. Returns a terminal ID for use with terminal_send, terminal_read, terminal_signal, terminal_close, and terminal_list.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Terminal backend type, usually \"shell\"." },
        name: { type: "string", description: "Optional display name such as \"main\" or \"gdb\"." },
        cwd: { type: "string", description: "Initial working directory. Defaults to the current workspace root." },
      },
      required: ["type"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const cwd = (args.cwd as string) || ctx.cwd;
      const name = args.name as string | undefined;
      const view = await getTerminalManager().open(cwd, name);
      const label = name === undefined ? view.sessionId : `${view.sessionId} (${name})`;
      return {
        title: "terminal_open",
        output: `started terminal session ${label} [type: ${view.type}]\nWorking directory: ${cwd}`,
        metadata: { sessionId: view.sessionId, cwd },
      };
    },
  };
}

export function createTerminalSendTool(): ToolDef {
  return {
    id: "terminal_send",
    guidance: "Use terminal_send to type text into an open terminal session. By default Enter is submitted and the call waits for output silence. Use run_in_background for long-running commands and collect output with job_output. Use terminal_signal to send Ctrl+C. An inferred_idle or timeout result does not prove the foreground command exited.",
    description: "Send text to a persistent terminal session. By default submits Enter and waits for the command to settle.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Terminal session ID from terminal_open or terminal_list." },
        text: { type: "string", description: "Text to write to the terminal." },
        submit: { type: "boolean", description: "Submit Enter after text (default true). Set false for control characters or incomplete REPL input." },
        run_in_background: { type: "boolean", description: "Return a job id immediately; collect with job_output or stop with job_kill." },
      },
      required: ["sessionId", "text"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.sessionId as string;
      const text = args.text as string;
      const submit = args.submit !== false;

      if (args.run_in_background === true) {
        const jobId = await getTerminalManager().sendBackground(id, text, submit);
        return {
          title: "terminal_send",
          output: `started background job ${jobId}`,
          metadata: { kind: "background", jobId },
        };
      }

      const result = await getTerminalManager().send(id, text, submit);
      const statusText = result.sessionStatus.kind === "running"
        ? "running"
        : `exited code=${result.sessionStatus.exitCode ?? "null"} signal=${result.sessionStatus.signal ?? "null"}`;
      const suffix = `\n[wait: ${result.waitReason}]${result.truncated ? "\n[output truncated]" : ""}\n[session: ${statusText}]`;
      return {
        title: "terminal_send",
        output: `${result.viewport || "(no new output)"}${suffix}`,
        metadata: {
          viewport: result.viewport,
          waitReason: result.waitReason,
          sessionStatus: result.sessionStatus,
          truncated: result.truncated,
        },
      };
    },
  };
}

export function createTerminalReadTool(): ToolDef {
  return {
    id: "terminal_read",
    guidance: "Use terminal_read to page backward through retained scrollback when a terminal_send result is truncated or you need earlier output.",
    description: "Read a bounded page from a terminal session's retained scrollback.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Terminal session ID." },
        offset: { type: "number", description: "Offset from the newest retained line (default 0)." },
        count: { type: "number", description: "Number of lines to read (default 100)." },
      },
      required: ["sessionId"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.sessionId as string;
      const offset = typeof args.offset === "number" ? args.offset : 0;
      const count = typeof args.count === "number" ? args.count : DEFAULT_READ_COUNT;
      const page = getTerminalManager().read(id, offset, count);
      const marker = page.totalLines === 0
        ? ""
        : `\n[lines: ${page.lineBegin}-${page.lineEnd} of ${page.totalLines}]${page.truncated ? "\n[output truncated]" : ""}`;
      return {
        title: "terminal_read",
        output: `${page.text || "(no retained output)"}${marker}`,
        metadata: {
          totalLines: page.totalLines,
          lineBegin: page.lineBegin,
          lineEnd: page.lineEnd,
          truncated: page.truncated,
        },
      };
    },
  };
}

export function createTerminalSignalTool(): ToolDef {
  return {
    id: "terminal_signal",
    guidance: "Use terminal_signal to send SIGINT (Ctrl+C) or SIGTSTP (Ctrl+Z) to the foreground process of a terminal session. Prefer terminal_close to end a session entirely.",
    description: "Send a control signal (SIGINT/Ctrl+C, Ctrl+D, SIGTSTP/Ctrl+Z) to a terminal session's foreground process.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Terminal session ID." },
        signal: {
          type: "string",
          enum: ["SIGINT", "SIGTSTP", "ctrl_c", "ctrl_d", "ctrl_z"],
          description: "Signal to send. SIGINT = Ctrl+C, SIGTSTP = Ctrl+Z, ctrl_d = EOF.",
        },
      },
      required: ["sessionId", "signal"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.sessionId as string;
      const signal = args.signal as string;
      const result = await getTerminalManager().signal(id, signal);
      return {
        title: "terminal_signal",
        output: `delivered ${result.target} to terminal ${id}`,
        metadata: { delivered: result.delivered, target: result.target },
      };
    },
  };
}

export function createTerminalCloseTool(): ToolDef {
  return {
    id: "terminal_close",
    guidance: "Use terminal_close to close a persistent terminal session opened with terminal_open. Closing kills the shell and its process tree.",
    description: "Close a terminal session and clean up its PTY.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Terminal session ID." },
      },
      required: ["sessionId"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const id = args.sessionId as string;
      const killed = await getTerminalManager().close(id);
      return {
        title: "terminal_close",
        output: killed ? `closed terminal session ${id}` : `terminal session not found: ${id}`,
        metadata: { killed },
      };
    },
  };
}

export function createTerminalListTool(): ToolDef {
  return {
    id: "terminal_list",
    guidance: "Use terminal_list to list your live terminal sessions and their status.",
    description: "List active terminal sessions opened by the current caller.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const sessions = getTerminalManager().list();
      if (sessions.length === 0) {
        return { title: "terminal_list", output: "(no terminal sessions)" };
      }
      const text = sessions.map((s) => {
        const name = s.name === undefined ? "" : ` (${s.name})`;
        const status = s.status.kind === "running"
          ? "running"
          : `exited code=${s.status.exitCode ?? "null"} signal=${s.status.signal ?? "null"}`;
        return `${s.sessionId}${name} [${s.type}] ${status}`;
      }).join("\n");
      return { title: "terminal_list", output: text, metadata: { sessions } };
    },
  };
}

// ========== 测试辅助导出 ==========

export function resetTerminalManagerForTest(): void {
  getTerminalManager().resetForTest();
}

export const _terminalManager = {
  get manager(): TerminalManager {
    return getTerminalManager();
  },
};

// ========== 后台任务查询导出（供 job_tools 集成） ==========

export function getTerminalBackgroundJob(jobId: string) {
  return getTerminalManager().getBackgroundJob(jobId);
}

export function listTerminalBackgroundJobs() {
  return getTerminalManager().listBackgroundJobs();
}

export async function killTerminalBackgroundJob(jobId: string): Promise<boolean> {
  return getTerminalManager().killBackgroundJob(jobId);
}
