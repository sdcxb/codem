/**
 * Host 的 **git 命令通道**（`CommandInvoker` 的 Node 实现）。
 *
 * ## 为什么需要它
 *
 * `src/core/environment/file-change-tracker.ts` 是桌面"按轮记录文件变更"的唯一实现。
 * 它以前通过 Tauri `execute_command` 跑 git；Host 的 Node 兼容层没有这条命令
 * （`tauri-compat.ts` 直接抛）⇒ `isGitRepo()` 恒 false ⇒ Host 的 `turn_file_changes`
 * **结构性永远为空**。这里给 Host 补上同一条通道：`spawn("git", ["-C", cwd, ...args])`，
 * **argv 形态、不经 shell** —— 于是同一份追踪器在 Host 里能原样工作，不需要第二套
 * `git status` 解析器（那会立刻与桌面定义漂移）。
 *
 * ## 安全边界（这条通道**不过审批**，所以必须在这里收口）
 *
 * 1. **子命令白名单**：`rev-parse` / `stash create` / `ls-files` / `diff` /
 *    `cat-file -e`（只查对象是否存在，是 `session.change.diff` 判断"记录来自
 *    哪个工作区"的唯一手段）。`cat-file` 只允许 `-e <对象名>`，不许 `-p` /
 *    `--batch`（那会把对象内容读出来，超出"存在性检查"的授权）。
 *    `add` / `commit` / `push` / `apply` / `checkout` / `reset` / `clean` / `pull` / `fetch`
 *    一律拒绝（返回非 0 退出码 + 明确 stderr，不抛给上层当"git 坏了"）。
 *    理由：Host 的自动提交开关读 `localStorage`（Node 里恒关），但**不能靠这个巧合当护栏**；
 *    一旦放开写命令，这条通道就是把 Host 变成静默 RCE / 静默提交用户工作区的入口。
 * 2. **危险选项拒绝**：`diff --output`（会写文件）、`--ext-diff` / `--textconv`（会执行
 *    仓库配置里的外部程序）、`--no-index`（可读任意路径）；`diff` 默认再加
 *    `--no-ext-diff --no-textconv`，把仓库配置的外部 diff 也关掉。
 * 3. **cwd 必须在 Host 工作区内**（与 `bash-run.ts` 同一条检查）。
 * 4. **超时杀进程树**（Windows `taskkill /T /F`；POSIX 进程组），输出有上限。
 *
 * ## 与桌面传输的差别（有意为之，不是两套行为）
 *
 * 桌面把一批 git 塞进一次 PowerShell（省 ~240ms/条，第 46 波）；Host 没有 PowerShell，
 * `runGitBatch` 就逐条 `spawn`。**语义完全相同**：每条命令各自的 stdout/stderr/退出码
 * 原样返回，批量只是传输层的调度优化。
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { CommandInvoker, GitCommandOptions, GitCommandResult } from "../../../src/core/command-api";
import { withoutLlmEnv } from "./llm-config";

export interface NodeGitInvokerOptions {
  /** 工作区根：所有 `cwd` 必须落在它里面（防止远程客户端指定任意仓库） */
  workspaceRoot: string;
  /** 单条命令默认超时（毫秒） */
  timeoutMs?: number;
}

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 100_000;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;

/**
 * 只读子命令白名单。
 *
 * `stash` 只允许 `create`：`stash drop/pop/apply` 会改工作区。
 */
const ALLOWED_SUBCOMMANDS = new Set(["rev-parse", "stash", "ls-files", "diff", "cat-file"]);

/** `diff` 上会写文件 / 执行外部程序的选项（子串拒绝，宁可误拒也不放过） */
const FORBIDDEN_DIFF_FLAGS = ["--output", "--ext-diff", "--textconv", "--no-index", "--ita-invisible-in-index"];

/**
 * `cat-file -e` 的对象名：与 `changes.ts` 的 `treeRef` 同一口径（4..64 位十六进制）。
 * 只接受对象名，拒绝把 `--batch` / `-p` / 任意 ref 塞进 argv。
 */
const CAT_FILE_OBJECT_RE = /^[0-9a-f]{4,64}$/i;

class GitCommandRejectedError extends Error {
  constructor(
    message: string,
    readonly exitCode = 126,
  ) {
    super(message);
    this.name = "GitCommandRejectedError";
  }
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function assertInsideWorkspace(workspaceRoot: string, cwd: string): void {
  const base = resolve(workspaceRoot);
  const target = resolve(cwd || base);
  const rel = toPosix(target).replace(/\/+$/, "");
  const root = toPosix(base).replace(/\/+$/, "");
  if (rel !== root && !rel.startsWith(root + "/")) {
    throw new GitCommandRejectedError(`cwd 逃出工作区：${cwd}`, 126);
  }
}

/**
 * 校验一条 git argv。返回 null = 放行；否则返回拒绝原因。
 *
 * **不解析 shell 元字符**：参数原样进 `spawn` 的 argv，所以 `; | & $()` 只是普通字符。
 * 这里仍然拒绝 NUL / 换行，因为它们是"命令行协议"里的结构字符，不是路径内容。
 */
function checkGitArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) return "git 参数不能为空";
  if (args.length > MAX_ARGS) return `git 参数过多（>${MAX_ARGS}）`;
  for (const arg of args) {
    if (typeof arg !== "string") return "git 参数必须是字符串";
    if (arg.includes("\u0000") || arg.includes("\n") || arg.includes("\r")) return "git 参数不能含 NUL/换行";
    if (arg.length > MAX_ARG_CHARS) return `git 参数过长（>${MAX_ARG_CHARS}）`;
  }
  const sub = args[0];
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    return `git 子命令 ${sub} 不在 Host 只读白名单（rev-parse / stash create / ls-files / diff / cat-file -e）`;
  }
  if (sub === "stash" && args[1] !== "create") {
    return "git stash 只允许 create（drop/pop/apply 会改工作区）";
  }
  if (sub === "cat-file") {
    if (args.length !== 3 || args[1] !== "-e" || !CAT_FILE_OBJECT_RE.test(args[2])) {
      return "git cat-file 只允许 `-e <对象名>`（存在性检查；不许读内容/批量）";
    }
  }
  if (sub === "diff") {
    for (const arg of args.slice(1)) {
      const hit = FORBIDDEN_DIFF_FLAGS.find((flag) => arg === flag || arg.startsWith(flag + "="));
      if (hit) return `git diff 选项 ${hit} 在 Host 被拒绝（会写文件或执行外部程序）`;
    }
  }
  return null;
}

/**
 * 跑一个子进程（argv，不经 shell）。超时/取消杀**进程树**；输出有上限。
 *
 * 单独导出是为了让"超时真的杀树"能被判据直接验证（`GITP-4`），
 * 而不是靠一条会自然结束的 git 命令去赌时序。
 */
export function runProcess(command: string, args: string[], opts: ProcessOptions = {}): Promise<ProcessResult> {
  const timeoutMs = Math.max(100, Math.min(120_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const isWin = process.platform === "win32";
  const started = Date.now();

  return new Promise<ProcessResult>((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    const append = (prev: string, chunk: Buffer, cap: number) =>
      prev.length >= cap ? prev : prev + chunk.toString("utf8").slice(0, cap - prev.length);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        shell: false,
        detached: !isWin,
      });
    } catch (e) {
      done({
        stdout: "",
        stderr: `无法启动 ${command}：${e instanceof Error ? e.message : String(e)}`,
        exitCode: 127,
        timedOut: false,
      });
      return;
    }
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
      const elapsed = Date.now() - started;
      done({
        stdout,
        stderr: timedOut ? `${stderr}\ngit 超时（${timeoutMs}ms，进程树已终止，耗时 ${elapsed}ms）` : stderr,
        exitCode: timedOut ? 124 : code,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout = append(stdout, c, MAX_STDOUT)));
    child.stderr?.on("data", (c: Buffer) => (stderr = append(stderr, c, MAX_STDERR)));
    child.on("error", (e) => {
      stderr += `\n无法启动 git：${e.message}`;
      finish(127);
    });
    child.on("close", (code) => finish(code));
  });
}

/** `git diff` 的默认安全选项：仓库配置的外部 diff / textconv 一律不跑 */
function hardenArgs(args: string[]): string[] {
  if (args[0] !== "diff") return args;
  return [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)];
}

/**
 * 创建 Host 的 git 命令通道。
 *
 * 注意：即使机器上没有 git，也**照样注册**（命令返回 127 而不是让 Host 启动失败）——
 * 这样"非 git 工作区 / 没装 git"会走既有降级路径（`isGitRepo()` false），
 * 由 `session.changes` 的 `supported:false + reason` 如实告诉客户端，而不是让 Host 起不来。
 */
export function createNodeGitInvoker(opts: NodeGitInvokerOptions): CommandInvoker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function runOne(cwd: string, args: string[], runOpts?: GitCommandOptions): Promise<GitCommandResult> {
    try {
      assertInsideWorkspace(opts.workspaceRoot, cwd);
    } catch (e) {
      return { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: 126 };
    }
    const rejection = checkGitArgs(args);
    if (rejection) {
      return { stdout: "", stderr: `命令被拒绝：${rejection}`, exitCode: 126 };
    }
    /**
     * 显式清掉会改写"仓库定位"的环境变量：Host 的仓库由 `--workspace` 决定，
     * 不能被宿主进程环境里的 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 改到别处。
     */
    const env: NodeJS.ProcessEnv = {
      ...withoutLlmEnv(process.env),
      // 不让 git 等终端输入 / 启动分页器；外部 diff 也显式清空
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
    };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    const result = await runProcess(
      "git",
      ["-C", cwd, "-c", "core.quotepath=false", "--no-pager", ...hardenArgs(args)],
      { timeoutMs: runOpts?.timeoutMs ?? timeoutMs, env },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  return {
    runGit: runOne,
    async runGitBatch(cwd, commands, runOpts) {
      const out: GitCommandResult[] = [];
      for (const args of commands) out.push(await runOne(cwd, args, runOpts));
      return out;
    },
  };
}
