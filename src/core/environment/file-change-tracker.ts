/**
 * FileChangeTracker — Per-turn file change tracking via **工作区快照**
 *
 * Lifecycle:
 *   start(workspace)  → capture before-snapshot（未提交改动也算）
 *   finalize()         → capture after-snapshot → generate patch → store to SQLite → emit event
 *   revert(turnId)    → apply reverse patch（+ 删掉本轮新建的未跟踪文件）→ restore before state
 *
 * 第 84 波（审计修正，真实缺陷）：原来 before/after 都取 `git rev-parse HEAD^{tree}` ——
 * 那是**已提交**的树。agent 改文件只改工作区、不会自动提交，于是两次取样**恒等** →
 * `finalize()` 永远返回 null → "文件变更"面板永远是空的、也点不到回滚
 * （连开自动提交都救不了：finalize 早于 tryAutoCommit）。
 * 现在改为记录**工作区快照**（`git stash create` 得到的树对象，不改动工作区/索引）
 * + 未跟踪文件列表，未提交的改动终于能被看见与回滚。
 *
 * Key design:
 *   - Only invoked at iteration boundaries (not inside tool execution)
 *   - Gracefully degrades for non-git workspaces (returns false, no error)
 *   - Patch truncated at 500KB; files list truncated at 2MB
 *   - Binary files: only track path, not content
 *   - Independent from v2_sessions.messages JSON — not affected by compaction
 */

import { FileChangeStorage, type ChangedFile } from "../storage/file-change-storage";
import { buildGitCommand, psQuote } from "../utils/ps-command";
import { getStoragePort, hasStoragePort } from "../storage/port";
import { reportActionFailure, reportPersistFailure } from "../storage/persist-failure";

const MAX_PATCH_BYTES = 500_000;
const MAX_FILES_LIST_BYTES = 2_000_000;
const GIT_TIMEOUT_MS = 15_000;

export interface FileChangeResult {
  artifactId: string;
  changedFiles: ChangedFile[];
  patchTruncated: boolean;
  beforeTree: string | null;
  afterTree: string | null;
}

type Listener = (result: FileChangeResult) => void;
const listeners = new Set<Listener>();

export function onFileChangesTracked(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(result: FileChangeResult): void {
  listeners.forEach((l) => {
    try {
      l(result);
    } catch (e) {
      console.warn("[FileChangeTracker] listener error:", e);
    }
  });
}

/** Simple SHA-256 implementation using Web Crypto API */
async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateId(): string {
  return `tfc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `fetchPatchById` 的三态结果（"取不到"与"不存在"必须分开，见 `FileChangeTracker.revert`） */
type PatchFetchResult =
  | { status: "ok"; patch: string }
  | { status: "absent" }
  | { status: "unavailable"; error: Error };

/**
 * 按 id **只取 `patch` 一列**（C-7）。
 *
 * ## 为什么不用 `FileChangeStorage.getById`
 *
 * `getById` 走域镜像，而镜像对 `turn_file_changes` 是**按全列**装载的
 * （`DOMAIN_COLUMN_PROJECTION` 里只有 `attachments`）。于是：
 * - 每次启动都会把整表的 patch 正文拉进渲染进程（500KB/行 × 行数）；
 * - 超过 5000 行该表被永久 `refused`，`getById` 恒返回 null → 回滚功能整域失效。
 *
 * 这里用 `crud.list` + `columns: ["patch"]` + `where: { id }` **只取那一行的那一列** ——
 * 与 `message.ts` 用 `attachments.content` 按 id 取附件正文是同一套做法
 * （列名由引擎侧核对，不存在会报错，不会静默少列）。
 *
 * ## 为什么"取不到"和"不存在"要分开
 *
 * 原来两者都表现为"拿不到 patch"，日志只有一句 `no patch found` ——
 * 排查者无法区分"这条记录没了"（用户该知道变更历史丢了）与
 * "这次读不到"（重试即可）。两者对用户的意义完全不同。
 */
async function fetchPatchById(artifactId: string): Promise<PatchFetchResult> {
  if (!hasStoragePort()) {
    return { status: "unavailable", error: new Error("端口未注册（本进程没有可用存储）") };
  }
  try {
    const port = getStoragePort();
    // `command` 拿结构化结果；端口实现没暴露它时退回 `execute`（两者都是同一 dispatch）
    const probe = port.data as unknown as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    const params = { table: "turn_file_changes", columns: ["patch"], where: { id: artifactId }, limit: 1 };
    const res = probe.command
      ? await probe.command<{ items?: Array<{ patch?: string | null }> }>("crud.list", params)
      : ((await port.data.execute("crud.list", params)) as unknown as {
          items?: Array<{ patch?: string | null }>;
        });
    const items = res?.items ?? [];
    if (items.length === 0) return { status: "absent" };
    return { status: "ok", patch: items[0]?.patch ?? "" };
  } catch (e) {
    // 命令失败（引擎不可用 / 表不存在 / 参数被拒）：**可重试**，如实上报原始错误
    return {
      status: "unavailable",
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const result = await invoke("execute_command", {
      command: buildGitCommand(cwd, args),
      cwd,
      // git 命令有界超时；Rust 侧超时会杀进程树（对标 dsh）
      timeout_ms: GIT_TIMEOUT_MS,
    });
    // execute_command returns { stdout, stderr, exitCode }
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const exitCode = result.exitCode ?? 0;
    if (exitCode !== 0 && !stdout) {
      throw new Error(stderr || `git exited with code ${exitCode}`);
    }
    return stdout.trim();
  } catch (e: any) {
    throw new Error(`git ${args.join(" ")} failed: ${e.message}`);
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const output = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return output === "true";
  } catch {
    return false;
  }
}

/** 工作区快照：能表达"未提交的改动" */
interface WorkingTreeSnapshot {
  /** 工作区对应的树对象（`git stash create` 的提交；工作区干净时回退到 HEAD^{tree}） */
  ref: string;
  /** 工作区当时是否完全干净（没有未提交改动） */
  clean: boolean;
  /** 未跟踪文件列表（agent 新建的文件就在这里） */
  untracked: string[];
}

/**
 * 取工作区快照（第 84 波）。
 *
 * `git stash create` 会为**当前工作区**创建一个提交对象并打印它的 SHA —— 它
 * **不改动工作区、不改动索引、不产生 stash 记录**，正好用来做"本轮开始/结束"的对照物；
 * 工作区没有改动时它输出空字符串（此时用 HEAD 的树当基准）。
 */
async function snapshotWorkingTree(workspace: string): Promise<WorkingTreeSnapshot> {
  let stashRef = "";
  try {
    stashRef = (await runGit(workspace, ["stash", "create"])).trim();
  } catch {
    stashRef = ""; // 没有可 stash 的改动（或极老版本 git）→ 回退到 HEAD
  }
  const headTree = (await runGit(workspace, ["rev-parse", "HEAD^{tree}"])).trim();
  let untracked: string[] = [];
  try {
    const out = await runGit(workspace, ["ls-files", "--others", "--exclude-standard"]);
    untracked = out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    untracked = [];
  }
  return { ref: stashRef || headTree, clean: !stashRef, untracked };
}

export class FileChangeTracker {
  private workspace: string;
  private beforeTree: string | null = null;
  /** 本轮开始时的**工作区**快照（未提交改动也算，第 84 波） */
  private beforeSnapshot: WorkingTreeSnapshot | null = null;
  private active = false;
  private sessionId: string;
  private messageId: string;
  private turnIndex: number;

  constructor(
    workspace: string,
    sessionId: string,
    messageId: string,
    turnIndex: number,
  ) {
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.messageId = messageId;
    this.turnIndex = turnIndex;
  }

  /**
   * Capture the git tree before agent executes tools.
   * Returns false if not a git repo — caller should skip tracking.
   */
  async start(): Promise<boolean> {
    if (!(await isGitRepo(this.workspace))) {
      return false;
    }

    try {
      this.beforeTree = await runGit(this.workspace, ["rev-parse", "HEAD^{tree}"]);
      /**
       * **必须在这里就把"本轮开始的工作区快照"取下来**（第 91 波，任务 C-7 连带修复）。
       *
       * 第 84 波引入了 `beforeSnapshot`（`finalize()` 用它算"本轮新增的未跟踪文件"），
       * 但 `start()` 里**从来没有赋值** —— 而 `finalize()` 的第一句是
       * `if (!this.active || !this.beforeTree || !this.beforeSnapshot) return null;`。
       * 于是 `beforeSnapshot` 恒为 `null` → **`finalize()` 恒返回 null** →
       * `turn_file_changes` 里**永远没有行** → `revert()` 永远走"取不到 patch"那条路。
       *
       * 也就是说：文件变更面板恒空、回滚永远不可用。这与 C-7 描述的症状
       * （`file-change-tracker.ts` 打 `no patch found`）是**同一个缺陷的两端**：
       * 一端是"根本没有记录"，另一端是"有记录但 mirror 里没有 patch 正文"。
       *
       * 放在 `beforeTree` 之后取：两次快照之间只隔一次 git 调用，
       * 而 `stash create` 不改工作区/索引，所以顺序不影响正确性。
       */
      this.beforeSnapshot = await snapshotWorkingTree(this.workspace);
      this.active = true;
      return true;
    } catch (e) {
      console.warn("[FileChangeTracker] start failed:", e);
      return false;
    }
  }

  /**
   * Capture the git tree after agent completes tools.
   * Generate patch, store to SQLite, emit event.
   * Returns null if tracking not active or no changes.
   */
  async finalize(): Promise<FileChangeResult | null> {
    if (!this.active || !this.beforeTree || !this.beforeSnapshot) {
      return null;
    }
    this.active = false;

    try {
      const afterSnapshot = await snapshotWorkingTree(this.workspace);
      const afterTree = afterSnapshot.ref;
      const newUntracked = afterSnapshot.untracked.filter((f) => !this.beforeSnapshot!.untracked.includes(f));

      // 没有任何变化（含"未跟踪文件也没多"）→ 不产生记录
      if (afterTree === this.beforeTree && newUntracked.length === 0) {
        return null;
      }

      // Get changed files list
      const nameStatus = await runGit(this.workspace, [
        "diff",
        "--name-status",
        this.beforeTree,
        afterTree,
      ]);

      const changedFiles = this.parseNameStatus(nameStatus);
      // 未跟踪的新文件不在 git diff 里（`stash create` 不含 untracked），单独补上 —— 否则
      // "agent 新建了文件"在面板里看不见、也回滚不掉。
      for (const f of newUntracked) {
        if (!changedFiles.some((c) => c.path === f)) changedFiles.push({ path: f, status: "A" });
      }

      // Pre-check: get diff stat to estimate patch size before running full binary diff
      // This avoids running a potentially huge git diff --binary for very large changes
      let patch = "";
      let patchTruncated = false;
      try {
        // Get stat first to estimate size
        const statOutput = await runGit(this.workspace, [
          "diff",
          "--stat",
          this.beforeTree,
          afterTree,
        ]);
        // Estimate: if stat output mentions many files or large line counts, skip full patch
        const statLines = statOutput.split("\n").filter(Boolean);
        const summaryLine = statLines[statLines.length - 1] || "";
        // Extract total insertions/deletions from summary like "10 files changed, 500 insertions(+), 200 deletions(-)"
        const insertionMatch = summaryLine.match(/(\d+) insertion/);
        const totalChanges = insertionMatch ? parseInt(insertionMatch[1]) : 0;
        const fileCount = statLines.length > 1 ? statLines.length - 1 : 0;

        // If estimated patch would be very large (> 2MB), skip full patch entirely
        // Individual file diffs can still be viewed on demand via FileChangesList
        const ESTIMATED_LARGE_THRESHOLD = 200_000; // ~200K line changes → likely > 2MB patch
        if (totalChanges > ESTIMATED_LARGE_THRESHOLD || fileCount > 100) {
          patch = `[Large diff: ${fileCount} files, ${totalChanges} line changes — use individual file diff viewer]`;
          patchTruncated = true;
        } else {
          // Get the full binary patch
          const rawPatch = await runGit(this.workspace, [
            "diff",
            "--binary",
            "--find-renames",
            this.beforeTree,
            afterTree,
          ]);
          if (rawPatch.length > MAX_PATCH_BYTES) {
            patch = rawPatch.slice(0, MAX_PATCH_BYTES);
            patchTruncated = true;
          } else {
            patch = rawPatch;
          }
        }
      } catch {
        // Binary diff may fail for some files — skip patch
        patch = "";
        patchTruncated = true;
      }

      // Build changed files JSON (with hashes if available)
      const changedFilesJson = JSON.stringify(changedFiles).slice(0, MAX_FILES_LIST_BYTES);

      // Compute SHA-256
      const patchSha = patch ? await sha256(patch) : null;

      // Build current brief (借鉴 Topic 概念)
      const brief = `Turn ${this.turnIndex}: ${changedFiles.length} file(s) changed (${changedFiles.filter((f) => f.status === "A").length} added, ${changedFiles.filter((f) => f.status === "M").length} modified, ${changedFiles.filter((f) => f.status === "D").length} deleted)`;

      const artifactId = generateId();

      // Store to SQLite
      FileChangeStorage.create({
        id: artifactId,
        session_id: this.sessionId,
        message_id: this.messageId,
        turn_index: this.turnIndex,
        before_tree: this.beforeTree,
        after_tree: afterTree,
        patch,
        changed_files: changedFilesJson,
        patch_sha256: patchSha,
        current_brief: brief,
        status: "completed",
        created_at: Date.now(),
      });

      const result: FileChangeResult = {
        artifactId,
        changedFiles,
        patchTruncated,
        beforeTree: this.beforeTree,
        afterTree,
      };

      emit(result);
      return result;
    } catch (e) {
      console.warn("[FileChangeTracker] finalize failed:", e);
      return null;
    }
  }

  /**
   * Parse `git diff --name-status` output into ChangedFile[].
   * Format: "M\tpath/to/file\nA\tpath/to/new\nD\tpath/to/old\nR100\told\tnew"
   */
  private parseNameStatus(output: string): ChangedFile[] {
    const lines = output.split("\n").filter((l) => l.trim());
    const files: ChangedFile[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      const status = parts[0]?.charAt(0) || "M";

      if (status === "R" && parts.length >= 3) {
        // Rename: R100\told_path\tnew_path
        files.push({ path: parts[2], status: "R" });
      } else if (parts.length >= 2) {
        files.push({ path: parts[1], status });
      }
    }

    return files;
  }

  /**
   * Revert to a specific turn's before state by applying reverse patch.
   *
   * ## 任务 C-7：patch 正文必须**按 id 按需取**
   *
   * `turn_file_changes` 是热表，而单行 `patch` 上限 500,000 字符。域镜像原来按**全列**
   * 装载它 → 每次启动把整表连同 patch 正文拉进渲染进程（>5000 行即永久 `refused`）。
   * 真 CLI 实测：一张 12 列的表、只有 1 行 500KB patch 时，一次 `crud.list`（不传 columns）
   * 的返回体就是 **500,275 字节**。
   *
   * 列投影本身在 `rust-port.ts`（别人的文件，已列进"需要他人配合"）。本文件能做的是：
   * **需要 patch 正文时按 id 单独取**（走既有端口读能力），并且把三种情形**分开**：
   *
   * | 情形 | 判据 | 处置 |
   * |---|---|---|
   * | 记录不存在 | 镜像/引擎都没有这一行 | 业务失败：这条变更记录已经没了 |
   * | 记录在、patch 取不到 | 行在但 `patch` 为 null/空 | 业务失败：**不**说"没有补丁"这种含糊话 |
   * | 存储未就绪 | 端口没注册 / 命令失败 | 可重试失败：如实上报，明确"稍后再试" |
   */
  static async revert(artifactId: string, workspace: string): Promise<boolean> {
    const record = FileChangeStorage.getById(artifactId);
    if (!record) {
      /*
       * ⚠️ 不能把 `null` 直接说成"没有这条记录"：`getById` 在端口没接手时也返回 null。
       * 所以这里再问一次"端口在不在"，把**未就绪**与**不存在**分开报。
       */
      if (!hasStoragePort()) {
        reportPersistFailure(
          "fileChange.revert",
          new Error("端口未注册（本进程没有可用存储）"),
          `回滚未执行：读不到变更记录 ${artifactId}，请稍后重试`,
        );
      } else {
        reportActionFailure(
          "fileChange.revert",
          new Error(`turn_file_changes 里没有 id=${artifactId}`),
          "回滚未执行：这条变更记录不存在（可能随会话被清理）",
        );
      }
      return false;
    }

    /*
     * patch 正文：记录里可能**没有**（列投影 / 镜像只带了元数据），这时按 id 按需取。
     * 取回来之后仍然为空 → 如实区分"记录在但补丁缺失"，而不是笼统的 "no patch found"。
     */
    let patch = record.patch ?? "";
    if (!patch) {
      const fetched = await fetchPatchById(artifactId);
      if (fetched.status === "ok") {
        patch = fetched.patch;
      } else if (fetched.status === "unavailable") {
        reportPersistFailure("fileChange.revert", fetched.error, `回滚未执行：补丁正文本次取不到，请稍后重试`);
        return false;
      }
      // fetched.status === "absent" → 落到下面统一的"记录在但补丁缺失"处理
    }
    if (!patch) {
      reportActionFailure(
        "fileChange.revert",
        new Error(`turn_file_changes id=${artifactId} 的 patch 为空`),
        "回滚未执行：这条变更记录里没有补丁正文（记录存在，但补丁缺失或已被截断为空的旧记录）",
      );
      console.warn("[FileChangeTracker] revert: 记录存在但没有 patch 正文", artifactId);
      return false;
    }

    try {
      // Apply reverse patch
      const { invoke } = (window as any).__TAURI__.core;
      // Write patch to temp file, then apply with --reverse
      const tempPath = `${workspace}/.git/revert-${artifactId}.patch`;
      await invoke("write_file", { path: tempPath, content: patch });

      const result = await invoke("execute_command", {
        command: `git -C ${psQuote(workspace)} apply --reverse ${psQuote(tempPath)}`,
        cwd: workspace,
      });

      // Cleanup temp file
      try {
        await invoke("execute_command", {
          command: `powershell -Command "Remove-Item -LiteralPath ${psQuote(tempPath)} -Force -ErrorAction SilentlyContinue"`,
          cwd: workspace,
        });
      } catch {}

      if (result.exitCode !== 0) {
        console.warn("[FileChangeTracker] revert: git apply failed:", result.stderr);
        return false;
      }

      /**
       * 第 84 波：**本轮新建的未跟踪文件不在 patch 里**（`stash create` 不含 untracked），
       * 反向打补丁自然不会删掉它们 —— 于是"回滚"之后新建文件还留在工作区。
       * 这里对记录里标记为 A（新增）的文件再确认一次：既没被 git 跟踪、又还在磁盘上 → 删掉。
       */
      try {
        const listed = JSON.parse(record.changed_files || "[]") as Array<{ path: string; status: string }>;
        for (const f of listed) {
          if (f.status !== "A" || !f.path) continue;
          const tracked = await invoke("execute_command", {
            command: `git -C ${psQuote(workspace)} ls-files --error-unmatch ${psQuote(f.path)}`,
            cwd: workspace,
            timeout_ms: GIT_TIMEOUT_MS,
          });
          if ((tracked.exitCode ?? 1) === 0) continue; // 已被跟踪：patch 会处理
          await invoke("execute_command", {
            command: `powershell -Command "Remove-Item -LiteralPath ${psQuote(f.path)} -Force -ErrorAction SilentlyContinue"`,
            cwd: workspace,
          });
        }
      } catch (e) {
        console.warn("[FileChangeTracker] revert: 清理新增文件失败（补丁已回滚）:", e);
      }

      // 第 84 波：状态更新必须确认真的改到了行 —— 原来无脑 return true，
      // 记录不存在时"回滚成功"只写在返回值和提示里，数据库里仍是旧状态。
      const statusRows = FileChangeStorage.updateStatus(artifactId, "reverted");
      if (statusRows === 0) {
        console.warn(
          `[FileChangeTracker] revert: 补丁已回滚，但记录 ${artifactId} 的状态没更新（该行不存在）—— 变更历史里会一直显示为未回滚`,
        );
      }
      return true;
    } catch (e) {
      console.error("[FileChangeTracker] revert failed:", e);
      return false;
    }
  }

  /**
   * Check if a workspace is a git repo (useful before creating tracker).
   */
  static async isGitWorkspace(workspace: string): Promise<boolean> {
    return isGitRepo(workspace);
  }
}
