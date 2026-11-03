/**
 * 命令层传输（CommandTransport）：**结构化 git 执行口**。
 *
 * ## 为什么需要它（与 `file-api.ts` 的 `FileTransport` 同一套纪律）
 *
 * `file-change-tracker.ts` 原来直接读 `window.__TAURI__.core.invoke("execute_command", {
 * command: "git -C …" })`，也就是**一条拼好的 PowerShell 命令串**。这在桌面成立，
 * 但有两个结构性后果：
 *
 * 1. Host（`packages/host`）没有 `execute_command`：Node 兼容层直接抛
 *    `未实现的 Tauri 命令` ⇒ `isGitRepo()` 恒 false ⇒ `turn_file_changes` 永远为空
 *    （不是"少"，是**结构性不可能**）；
 * 2. 命令串要经过 shell，参数里的 `;` / `|` / `$` 必须靠 `psQuote` 转义 ——
 *    每多一个调用点就多一次"转义漏了"的机会。
 *
 * 现在把"跑一条 git"收成一个**显式注入点**：`runGit(cwd, args: string[])`，
 * argv 形态、不经 shell；桌面默认实现仍走原来的 `execute_command`（行为逐字不变），
 * Host 注入 `spawn("git", ["-C", cwd, ...args])`（见 `packages/host/src/git-exec.ts`）。
 *
 * ## 批量化为什么留在这一层
 *
 * 桌面每条 git 都是一个 PowerShell 进程（实测 ~240ms/条），所以 `snapshotWorkingTree`
 * 与 `finalize()` 的几条命令要**合成一次**执行（第 46 波）。这个优化只属于桌面传输：
 * 它由 `runGitBatch` 的**可选实现**表达，而不是在追踪器里再写一套 shell。
 * Host 的 `runGitBatch` 是逐条 `spawn`（无 shell、无哨兵）。
 *
 * `GIT_BATCH_SENTINEL` / `parseGitBatchOutput` 仍从 `file-change-tracker.ts` re-export
 * （既有判据 `GB-1..7` 从那里 import），但**实现只有这一份**。
 */

import { buildGitCommand } from "./utils/ps-command";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface GitCommandOptions {
  /** 单条命令/整批命令的墙钟预算（毫秒） */
  timeoutMs?: number;
}

/**
 * 命令通道。`runGit` 是必需的；`runGitBatch` 是**传输能力**（不是行为开关）：
 * 有它就用它（桌面一次 PowerShell），没有就逐条 `runGit`（Host / 测试）。
 */
export interface CommandInvoker {
  runGit(cwd: string, args: string[], opts?: GitCommandOptions): Promise<GitCommandResult>;
  runGitBatch?(cwd: string, commands: string[][], opts?: GitCommandOptions): Promise<GitCommandResult[]>;
}

let commandInvoker: CommandInvoker | null = null;

/** 注册/清除命令通道（传 null 恢复 Tauri 默认）。 */
export function setCommandInvoker(invoker: CommandInvoker | null): void {
  commandInvoker = invoker;
}

const GIT_TIMEOUT_MS = 15_000;

/**
 * 批量化哨兵：**必须包含 Windows 文件名里非法的字符**（`< > | ? *`）。
 *
 * 为什么（第 46 波 + GB-6）：`ls-files --others` 的输出就是文件名清单；若哨兵是一个
 * 合法文件名，仓库里恰好存在同名文件时 `split(哨兵)` 会错位 ⇒ 解析出别人的内容且不报错。
 * Windows 路径里不可能出现这几个字符，所以文件名永远撞不上。
 */
export const GIT_BATCH_SENTINEL = "@@CODEM<>GIT|BATCH?SEP*@@";

/** 纯解析（不碰 Tauri / Node ⇒ 可单测/可变异） */
export function parseGitBatchOutput(out: string, count: number): Array<{ stdout: string; exitCode: number }> {
  const parts = String(out ?? "").split(GIT_BATCH_SENTINEL);
  const firstLine = (s: string) => {
    const nl = s.indexOf("\n");
    return (nl >= 0 ? s.slice(0, nl) : s).trim();
  };
  const restAfterFirstLine = (s: string) => {
    const nl = s.indexOf("\n");
    return nl >= 0 ? s.slice(nl + 1).trim() : "";
  };
  const res: Array<{ stdout: string; exitCode: number }> = [];
  for (let i = 0; i < count; i++) {
    const stdout = i === 0 ? (parts[0] ?? "").trim() : restAfterFirstLine(parts[i] ?? "");
    const codeText = i === count - 1 ? firstLine(parts[count] ?? "") : firstLine(parts[i + 1] ?? "");
    const code = Number(codeText || "0");
    res.push({ stdout, exitCode: Number.isFinite(code) ? code : 0 });
  }
  return res;
}

/**
 * 全局 git 参数：**必须关掉 path 转义**（第 233 轮顺带修）。
 *
 * `git diff --name-status` 默认会把非 ASCII 路径写成 `"\346\226\207…"`，随后
 * `git show <tree>:<path>` 必然找不到文件。`core.quotepath=false` 让路径按 UTF-8 原样输出，
 * 与 `-z` 之外的既有解析口径兼容。
 */
function withGlobalGitArgs(args: string[]): string[] {
  return ["-c", "core.quotepath=false", ...args];
}

/** 桌面默认实现：仍走 Tauri `execute_command`（PowerShell 里的 `git -C …`） */
async function tauriRunGit(
  cwd: string,
  args: string[],
  opts: GitCommandOptions,
): Promise<GitCommandResult> {
  const invoke = (globalThis as any).__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("命令通道未就绪：未注册 CommandInvoker，且没有 Tauri 运行时");
  }
  const result = await invoke("execute_command", {
    command: buildGitCommand(cwd, withGlobalGitArgs(args)),
    cwd,
    timeout_ms: opts.timeoutMs ?? GIT_TIMEOUT_MS,
  });
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
    exitCode: result?.exitCode ?? (result ? 0 : null),
  };
}

/** 桌面默认批量化：一次 PowerShell 里跑 N 条，哨兵带出每条退出码 */
async function tauriRunGitBatch(
  cwd: string,
  commands: string[][],
  opts: GitCommandOptions,
): Promise<GitCommandResult[]> {
  const invoke = (globalThis as any).__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("命令通道未就绪：未注册 CommandInvoker，且没有 Tauri 运行时");
  }
  const body = commands
    .map((args) => `${buildGitCommand(cwd, withGlobalGitArgs(args))}; Write-Output "${GIT_BATCH_SENTINEL}$LASTEXITCODE"`)
    .join("; ");
  const result = await invoke("execute_command", {
    command: body,
    cwd,
    timeout_ms: opts.timeoutMs ?? GIT_TIMEOUT_MS,
  });
  return parseGitBatchOutput(String(result?.stdout ?? ""), commands.length).map((item) => ({
    stdout: item.stdout,
    stderr: String(result?.stderr ?? ""),
    exitCode: item.exitCode,
  }));
}

/** 跑一条 git（argv，不经 shell）。未注册通道时回落到 Tauri 默认实现。 */
export async function runGitCommand(
  cwd: string,
  args: string[],
  opts: GitCommandOptions = {},
): Promise<GitCommandResult> {
  if (commandInvoker) return commandInvoker.runGit(cwd, args, opts);
  return tauriRunGit(cwd, args, opts);
}

/**
 * 跑一批 git。有 `runGitBatch` 就用（桌面一次 PowerShell）；
 * 否则**逐条** `runGit`（Host 的实现在那边也是逐条 spawn，这里只是兜底）。
 */
export async function runGitBatchCommands(
  cwd: string,
  commands: string[][],
  opts: GitCommandOptions = {},
): Promise<GitCommandResult[]> {
  if (commandInvoker?.runGitBatch) return commandInvoker.runGitBatch(cwd, commands, opts);
  if (commandInvoker) {
    const out: GitCommandResult[] = [];
    for (const args of commands) out.push(await commandInvoker.runGit(cwd, args, opts));
    return out;
  }
  return tauriRunGitBatch(cwd, commands, opts);
}
