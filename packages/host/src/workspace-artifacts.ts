/**
 * Host 内部产物（`.codem-attachments` / `.codem-snapshots` / …）与**用户 git** 的隔离。
 *
 * ## 问题
 *
 * 共享桌面工作区时，Host 会往用户项目里写两类东西：
 * - `.codem-attachments/<id>__<name>`：本轮附件的副本（模型要用 `read`/`grep` 读它）；
 * - `.codem-snapshots/*.json`：改动前快照（**共享工作区下已关闭**，见 `snapshotsEnabledForWorkspace`）。
 *
 * 这些目录不在用户仓库的 `.gitignore` 里 ⇒ `git status` 会看到未跟踪目录，变更追踪器会把它
 * 当成"本轮新增文件"记进 `turn_file_changes`，模型看到"新增文件"还会去读/提交。
 *
 * ## 做法
 *
 * 只维护 **`.git/info/exclude`**（本地、不入库、只影响本仓库）：
 * - 不改 `.gitignore`（tracked 文件，会把改动带进用户提交）；
 * - 不改全局 `core.excludesFile`（会影响用户所有仓库）。
 *
 * 标记块之外的每一行都**原样保留**；幂等（连续调用不会多出第二块）。
 * 无 git / 非 git 工作区 ⇒ 返回 `ok:false` 明确降级（调用方记日志，不假装已排除）。
 *
 * ## 安全护栏（必须）
 *
 * `.git` 可以是一个**文件**，内容 `gitdir: <任意路径>` ⇒ 直接照 `git rev-parse --git-path`
 * 去写，等于把"自动维护排除块"变成对任意目录的写。所以写入前必须确认：
 * 1. 目标 `info/exclude` 位于解析出的 git dir 或 common dir 内；
 * 2. git dir 不在工作区内时，只接受**真实的 worktree**（`.git` 文件指向
 *    `<common>/.git/worktrees/<name>`，且 common dir 是它的祖先）；
 * 3. `info/` 目录必须已存在（不自动创建目录）、目标不是符号链接。
 * 任何一条不满足 ⇒ 拒绝写入并返回 reason（`unsafe-git-dir` / `unsafe-exclude-path`）。
 */
import { lstat, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { runProcess } from "./git-exec";

/** 需要排除的内部产物目录（相对工作区根；不带前导 `/` ⇒ 任意层级都命中） */
export const WORKSPACE_ARTIFACT_EXCLUDE_PATTERNS = [
  ".codem-attachments/",
  ".codem-snapshots/",
  ".attachments/",
  ".codem-tool-results/",
] as const;

const MARKER_BEGIN = "# >>> codem workspace artifacts (managed by Codem) >>>";
const MARKER_END = "# <<< codem workspace artifacts (managed by Codem) <<<";

/** 附件副本目录（模型要通过 `read`/`grep` 读，所以留在工作区内） */
export const ATTACHMENT_SCRATCH_DIR = ".codem-attachments";
/** 只清理 App 自己命名的附件副本：`att-<id>__<name>` */
export const ATTACHMENT_SCRATCH_PATTERN = /^att-[a-z0-9-]+__/i;
/** 附件副本的驻留时间：下一轮模型可能还要读同一附件，不能每轮结束就删 */
export const ATTACHMENT_SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 共享工作区下**是否启用**自动快照。
 *
 * 关闭的两个理由（都被判据/取证支持）：
 * 1. Host 没有任何快照查看/回滚 RPC ⇒ 这些 JSON 对 Host 是纯负债，却把完整源码落进用户仓库；
 * 2. 快照在工具执行**之前**读目标文件，而 Host 的写审批在工具内部 ⇒ 快照先于审批读盘，
 *    会给"敏感读取审批"开一个旁路（模型请求写 `.env`，即使用户拒绝，内容也已进快照）。
 */
export function snapshotsEnabledForWorkspace(sharedWithDesktop: boolean): boolean {
  return !sharedWithDesktop;
}

/**
 * 是否要在**这个工作区**上维护内部产物隔离（exclude + 附件清理）。
 *
 * 与 `snapshotsEnabledForWorkspace` 是同一事实的两面：只有"桌面共享的项目"才需要
 * ① 关快照、② 写 exclude、③ 清理附件副本。Android 本机 / 开发机手跑一律不动
 * （那边的目录是 Host 自己的，写 exclude 没有意义，还可能动到用户显式指过来的仓库）。
 */
export function shouldManageWorkspaceArtifacts(sharedWithDesktop: boolean): boolean {
  return sharedWithDesktop;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function pathKey(p: string): string {
  const normalized = toPosix(resolve(p)).replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(parent: string, child: string): boolean {
  const p = pathKey(parent);
  const c = pathKey(child);
  return c === p || c.startsWith(p + "/");
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

export type WorkspaceExcludeFailureReason =
  | "no-git"
  | "not-a-git-repo"
  | "unsafe-git-dir"
  | "unsafe-exclude-path"
  | "read-failed"
  | "write-failed"
  | "internal-error";

export type WorkspaceExcludeResult =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; reason: WorkspaceExcludeFailureReason; message: string; path?: string };

interface GitRunResult {
  code: number | null;
  out: string;
  err: string;
}

/** 跑一条只读 git 命令（显式清掉会改写"仓库定位"的环境变量） */
async function git(root: string, args: string[]): Promise<GitRunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const result = await runProcess("git", ["-C", root, ...args], { timeoutMs: 10_000, env });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
}

/** 标记块（按内容串起来便于判据直接比对） */
function excludeBlock(eol: string): string {
  return [MARKER_BEGIN, ...WORKSPACE_ARTIFACT_EXCLUDE_PATTERNS, MARKER_END].join(eol);
}

/**
 * 把标记块合并进已有内容：**保留块外所有行**；已有标记块则原位替换；没有则追加到末尾。
 *
 * 单独导出是为了让"不覆盖用户内容 / 幂等"这两条能被纯函数判据直接盯住。
 */
export function mergeExcludeBlock(existing: string, eol?: string): string {
  const useEol = eol ?? (existing.includes("\r\n") ? "\r\n" : "\n");
  let base = existing.replace(/\r\n/g, "\n");
  const block = excludeBlock("\n");
  const begin = base.indexOf(MARKER_BEGIN);
  const end = begin >= 0 ? base.indexOf(MARKER_END, begin) : -1;
  let next: string;
  if (begin >= 0 && end > begin) {
    next = base.slice(0, begin) + block + base.slice(end + MARKER_END.length);
  } else {
    if (begin >= 0) {
      /*
       * 只有开始标记、没有结束标记（用户手改过 / 旧版本残留 / 极端崩溃）。
       * **必须先删掉这个孤立标记**再追加：否则下一次合并会从它一直吞到新块的结束标记，
       * 把中间的用户行当成"块内容"整段替换掉 —— 那正是"不覆盖用户内容"要禁止的。
       */
      base = base.slice(0, begin) + base.slice(begin + MARKER_BEGIN.length).replace(/^\n/, "");
    }
    const prefix = base.length === 0 ? "" : base.endsWith("\n") ? "\n" : "\n\n";
    next = base + prefix + block;
  }
  if (!next.endsWith("\n")) next += "\n";
  /*
   * 不折叠空行：用户自己在 exclude 里留的连续空行也是用户内容的一部分，
   * "整理格式"会让本判据的"保留块外所有行"变成假话。
   */
  return next.replace(/\n/g, useEol);
}

/**
 * 判断"git dir 在工作区外"是否是**真的 worktree**。
 *
 * 规则（任一不满足即视为可疑重定向）：
 * - `<root>/.git` 是普通文件（不是目录、不是符号链接）；
 * - 文件里的 `gitdir:` 与 `rev-parse --absolute-git-dir` 解析到同一路径；
 * - git dir 位于 `<common>/worktrees/<name>` 之下（git worktree 的管理目录布局）。
 *
 * 只指向 `<other>/.git` 的恶意 `.git` 文件不满足最后一条 ⇒ 拒绝写入。
 */
async function isRealWorktree(root: string, gitDirReal: string, commonDirReal: string): Promise<boolean> {
  const entry = join(root, ".git");
  const info = await lstat(entry).catch(() => null);
  if (!info || !info.isFile()) return false;
  const text = await readFile(entry, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return false;
  const declaredRaw = match[1].trim();
  const declaredAbs = isAbsolute(declaredRaw) ? declaredRaw : resolve(root, declaredRaw);
  const declaredReal = await realpath(declaredAbs).catch(() => resolve(declaredAbs));
  if (!samePath(declaredReal, gitDirReal)) return false;
  if (!toPosix(gitDirReal).toLowerCase().includes("/.git/worktrees/")) return false;
  return isInside(commonDirReal, gitDirReal);
}

/**
 * 幂等维护 `.git/info/exclude` 里的内部产物排除块。
 *
 * **永不抛出**：所有失败都收敛成 `ok:false + reason`（调用方负责日志/降级）。
 */
export async function ensureWorkspaceArtifactExcludes(root: string): Promise<WorkspaceExcludeResult> {
  try {
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.out.trim() !== "true") {
      const message = inside.code === 127
        ? `无法运行 git：${inside.err.trim() || "git 不可用"}`
        : `不是 git 工作区：${inside.err.trim() || `exit ${String(inside.code)}`}`;
      return { ok: false, reason: inside.code === 127 ? "no-git" : "not-a-git-repo", message };
    }

    const [gitDirOut, commonOut, excludeOut, topLevelOut] = await Promise.all([
      git(root, ["rev-parse", "--absolute-git-dir"]),
      git(root, ["rev-parse", "--git-common-dir"]),
      git(root, ["rev-parse", "--git-path", "info/exclude"]),
      git(root, ["rev-parse", "--show-toplevel"]),
    ]);
    if (gitDirOut.code !== 0 || commonOut.code !== 0 || excludeOut.code !== 0 || topLevelOut.code !== 0) {
      return {
        ok: false,
        reason: "not-a-git-repo",
        message: `git 无法解析仓库路径：${(gitDirOut.err || commonOut.err || excludeOut.err || topLevelOut.err).trim()}`,
      };
    }

    const gitDir = gitDirOut.out.trim();
    const commonDir = resolve(root, commonOut.out.trim());
    const excludePath = resolve(root, excludeOut.out.trim());
    const workspaceReal = await realpath(root).catch(() => resolve(root));
    const gitDirReal = await realpath(gitDir).catch(() => resolve(gitDir));
    const commonDirReal = await realpath(commonDir).catch(() => resolve(commonDir));
    const topLevelReal = await realpath(topLevelOut.out.trim()).catch(() => resolve(topLevelOut.out.trim()));

    /*
     * 归属判断（必须三条一起看）：
     * - 工作区必须在 git 的 toplevel 之内（git 自己的定义，防"根目录被换掉"）；
     * - git dir 必须**在 toplevel 内**（普通仓库，含"把仓库子目录当工作区"的情况）；
     *   或 git dir 在工作区外但确实是**真实 worktree**（`git worktree add` 的管理目录在 common 里）。
     * 一个只写着 `gitdir: <别的仓库>/.git` 的恶意 `.git` 文件两条都不满足 ⇒ 拒绝写入。
     *
     * 注意不能用"git dir 是工作区的祖先"：仓库子目录当工作区时，`.git` 是仓库根的兄弟
     * （`repo/.git` vs `repo/packages/app`），祖先关系不成立，会误拒。
     */
    const workspaceInsideTopLevel = isInside(topLevelReal, workspaceReal);
    const gitDirInsideTopLevel = isInside(topLevelReal, gitDirReal);
    if (
      !workspaceInsideTopLevel ||
      (!gitDirInsideTopLevel && !(await isRealWorktree(root, gitDirReal, commonDirReal)))
    ) {
      return {
        ok: false,
        reason: "unsafe-git-dir",
        message: `git dir 与工作区没有归属关系（拒绝写入）：${toPosix(gitDirReal)}`,
        path: toPosix(excludePath),
      };
    }

    const excludeDir = dirname(excludePath);
    const excludeDirReal = await realpath(excludeDir).catch(() => null);
    if (!excludeDirReal) {
      return {
        ok: false,
        reason: "unsafe-exclude-path",
        message: `git 的 info 目录不存在（不自动创建）：${toPosix(excludeDir)}`,
        path: toPosix(excludePath),
      };
    }
    const target = join(excludeDirReal, basename(excludePath));
    if (!isInside(gitDirReal, target) && !isInside(commonDirReal, target)) {
      return {
        ok: false,
        reason: "unsafe-exclude-path",
        message: `排除文件不在 git dir / common dir 内（拒绝写入）：${toPosix(target)}`,
        path: toPosix(target),
      };
    }
    const targetInfo = await lstat(target).catch(() => null);
    if (targetInfo?.isSymbolicLink()) {
      return {
        ok: false,
        reason: "unsafe-exclude-path",
        message: `排除文件是符号链接（拒绝写入）：${toPosix(target)}`,
        path: toPosix(target),
      };
    }

    let existing = "";
    try {
      existing = await readFile(target, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        return {
          ok: false,
          reason: "read-failed",
          message: `读取 ${toPosix(target)} 失败：${(e as Error)?.message ?? String(e)}`,
          path: toPosix(target),
        };
      }
    }
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const next = mergeExcludeBlock(existing, eol);
    if (next === existing) {
      return { ok: true, path: toPosix(target), changed: false };
    }

    /*
     * 原子写：先写同目录临时文件再 rename（Windows 的 rename 会覆盖已存在文件）。
     * 不直接截断写：中途失败会留下半块标记，Git 仍能工作，但"重复块"会一直累积。
     */
    const tmp = `${target}.codem-${process.pid}-${Date.now()}.tmp`;
    try {
      await writeFile(tmp, next, "utf8");
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      return {
        ok: false,
        reason: "write-failed",
        message: `写入 ${toPosix(target)} 失败：${(e as Error)?.message ?? String(e)}`,
        path: toPosix(target),
      };
    }
    return { ok: true, path: toPosix(target), changed: true };
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface PruneAttachmentsResult {
  removed: number;
  kept: number;
  errors: string[];
}

/**
 * 清理 `.codem-attachments` 里**过期**的副本（只删 App 自己命名的普通文件）。
 *
 * 为什么是 TTL 而不是"每轮删"：下一轮模型可能还要读同一附件（prompt 里给的是相对路径）。
 * 规范副本在 `dataHome/attachments`，重发附件即可恢复；用户自己放进该目录的文件**不删**。
 */
export async function pruneWorkspaceAttachments(
  root: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): Promise<PruneAttachmentsResult> {
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? ATTACHMENT_SCRATCH_TTL_MS);
  const now = opts.now ?? Date.now();
  const dir = join(root, ATTACHMENT_SCRATCH_DIR);
  const result: PruneAttachmentsResult = { removed: 0, kept: 0, errors: [] };
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e?.code !== "ENOENT") result.errors.push(`读取 ${dir} 失败：${e?.message ?? String(e)}`);
    return [];
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!ATTACHMENT_SCRATCH_PATTERN.test(entry.name)) continue;
    const abs = join(dir, entry.name);
    const info = await stat(abs).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs < maxAgeMs) {
      result.kept += 1;
      continue;
    }
    try {
      await unlink(abs);
      result.removed += 1;
    } catch (e) {
      result.errors.push(`删除 ${entry.name} 失败：${(e as Error)?.message ?? String(e)}`);
    }
  }
  // 目录空了再删；非空（用户自己放了东西）保留
  const remaining = await readdir(dir).catch(() => null);
  if (remaining && remaining.length === 0) {
    await rmdir(dir).catch(() => undefined);
  }
  return result;
}
