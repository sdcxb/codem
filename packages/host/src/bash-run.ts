/**
 * Host 的命令执行器（G-7）——**与模型/循环解耦**，可单测。
 *
 * 安全边界都在这里：
 * - 必须由 `approve()` 放行（审批在 runtime 侧发出；本函数不关心 UI）；
 * - `cwd` 只能是工作区内的相对路径；
 * - 默认 60s 超时、上限 300s；超时/取消杀**进程树**；
 * - stdout/stderr 各截到 120k 字符，避免把宿主内存打爆。
 */
import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";

import { withoutLlmEnv } from "./llm-config";

export interface BashRunOptions {
  command: string;
  workspace: string;
  /** 相对工作区的目录（可空） */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  approve: () => Promise<{ allowed: boolean; note?: string }>;
}

export interface BashRunResult {
  output: string;
  isError: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

const OUTPUT_CAP = 120_000;

export async function executeBash(opts: BashRunOptions): Promise<BashRunResult> {
  const command = opts.command.trim();
  if (!command) return { output: "Error: command 不能为空", isError: true, exitCode: null, timedOut: false, durationMs: 0 };
  if (command.length > 20_000) {
    return { output: "Error: command 太长（>20000 字符）", isError: true, exitCode: null, timedOut: false, durationMs: 0 };
  }

  const base = resolve(opts.workspace);
  const cwd = opts.cwd?.trim() ? resolve(base, opts.cwd.trim()) : base;
  if (cwd !== base && !cwd.startsWith(base + sep)) {
    return {
      output: `Error: cwd 逃出工作区：${opts.cwd}`,
      isError: true,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    };
  }

  const decision = await opts.approve();
  if (!decision.allowed) {
    return {
      output: `命令未执行（用户拒绝${decision.note ? `：${decision.note}` : ""}）`,
      isError: true,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    };
  }

  const timeoutMs = Math.max(1000, Math.min(300_000, opts.timeoutMs ?? 60_000));
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/bash";
  const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-lc", command];
  const started = Date.now();

  return await new Promise<BashRunResult>((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    const append = (prev: string, chunk: Buffer) =>
      prev.length >= OUTPUT_CAP ? prev : prev + chunk.toString("utf8").slice(0, OUTPUT_CAP - prev.length);

    /*
     * `env` 不能直接给 `process.env`：模型跑一次 `env` 就能把 API Key 打进工具输出，
     * 而工具输出会被写成会话消息（= 泄漏给会话记录/截图/导出）。见 `llm-config.ts`。
     */
    const child = spawn(shell, shellArgs, {
      cwd,
      env: withoutLlmEnv(process.env),
      detached: !isWin,
      windowsHide: true,
    });
    const pid = child.pid;
    const killTree = () => {
      try {
        if (isWin) {
          if (pid) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        } else if (pid) {
          process.kill(-pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    };
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      const ms = Date.now() - started;
      const parts = [
        `$ ${command}`,
        timedOut ? `(已超时 ${timeoutMs}ms，进程树已终止)` : `(exit ${code ?? "null"}，${ms}ms)`,
        stdout ? `--- stdout ---\n${stdout.trimEnd()}` : "",
        stderr ? `--- stderr ---\n${stderr.trimEnd()}` : "",
      ].filter(Boolean);
      done({
        output: parts.join("\n"),
        isError: timedOut || (code ?? 0) !== 0,
        exitCode: code,
        timedOut,
        durationMs: ms,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = () => {
      timedOut = true;
      killTree();
    };
    opts.signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = append(stderr, c)));
    child.on("error", (e) => {
      stderr += `\n无法启动命令：${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
