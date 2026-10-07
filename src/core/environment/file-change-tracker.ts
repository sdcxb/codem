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
 * ## 为什么不用 `FileChangeStorage.getByIdAsync`
 *
 * 按需读（一屏投影）**刻意不含 `patch` 正文** ✓ —— 那是这张表里唯一的大列
 * （单行上限 500,000 字符 ✗），而列表 / 状态更新 / 回滚要用的 `changed_files` 都不需要它 ✓
 * （判据 `TFC-4` 钉这条 ✓）。所以"一屏"最多几百行 × 小列 ✓，
 * 而"取正文"是一个**精确到一行一列**的读 ✓。
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

/**
 * ★★★ 第 46 波：**把 N 条 git 命令塞进一次 PowerShell 调用** ✓（目标② 的实测着力点 ✓）。
 *
 * ## 为什么（**真机实测 ✓**）
 *
 * 应用里每条 git 命令都经 `execute_command` ⇒ **一个 PowerShell 进程** ✓，
 * 而 PowerShell 起进程的固定开销是**大头** ✗。在同一台机器、同一个评测工作区上实测（`PowerShell` 直接计时 ✓）：
 * ```
 *   git rev-parse 'HEAD^{tree}'（直接 ✓）                          52 ms
 *   powershell -NoProfile -Command "git rev-parse 'HEAD^{tree}'"  289 ms   ← ★ 每次多付 ~240 ms ✗
 *   6 × 独立 powershell -Command                                  1 648 ms
 *   1 × powershell 里跑 6 条 git（批量化 ✓）                        638 ms   ← ★ 省 ~1 s ✓
 * ```
 * 而 `snapshotWorkingTree` 一轮就要 **3 条** ✓（`stash create` / `rev-parse` / `ls-files` ✓）+
 * `finalize()` 的 diff 再有几条 ✓ ⇒ ★ 真机侧车里"工具结果回来 → `Iteration N completed`"
 * 之间稳定 **~2 s 且一行日志都没有** ✗ —— 就是这里 ✓（`finalize()` **每轮都会调用** ✓）。
 *
 * ## 口径（**为什么要哨兵 + 退出码** ✓）
 *
 * `stdout` 里必须能**逐条**拆出来，而且**每条自己的退出码不能丢** ✗
 * （丢了的话"命令失败"会被读成"输出为空" ✓ —— 那正好是 `stash create` 干净工作区的**正常**输出 ✗ 会混淆）。
 * 于是每条的写法是：`<cmd>; Write-Output "<哨兵>$LASTEXITCODE"` ✓ —— 也就是
 * **哨兵行挂在每条命令后面、并带上它自己的退出码** ✓。
 *
 * 拆法（`n` 条命令 ⇒ `split(哨兵)` 得到 `n+1` 段 ✓）：
 * ```
 * 段[0]        = 第 0 条的输出
 * 段[i] (1≤i≤n-1) = "第 i-1 条的退出码\n" + 第 i 条的输出
 * 段[n]        = 第 n-1 条的退出码
 * ```
 * ⚠️ 哨兵必须挑**git 输出里不可能出现的字符串** ✓（纯函数 `parseGitBatchOutput` 可单测 ✓）。
 */
/**
 * ★ 哨兵：**必须包含 Windows 文件名里非法的字符** ✓（`< > | ? *` ✓）。
 *
 * 为什么（**先怀疑自己的改动** ✓）：`ls-files --others` 的输出就是**文件名清单** ✓ ——
 * 若哨兵是一个合法文件名 ✗，那么仓库里恰好存在同名文件时 `split(哨兵)` 就会**错位** ✓
 * ⇒ 解析出来的 diff/清单是**静默错**的 ✗（最坏的一种 ✓：不报错、但内容是别人的 ✓）。
 * 而 Windows 路径里不可能出现 `< > | ? *` ✓ ⇒ 文件名永远撞不上哨兵 ✓（本应用只跑 Windows ✓）。
 * 判据 `GB-6` 钉住这一点 ✓。
 */
export const GIT_BATCH_SENTINEL = "@@CODEM<>GIT|BATCH?SEP*@@";

/**
 * 纯解析 ✓（不碰 Tauri ⇒ 可单测/可变异 ✓）。
 *
 * @param out 批量化命令的完整 stdout
 * @param count 命令条数（`split` 的段数应当是 `count + 1` ✓）
 */
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

/** 批量化执行 ✓（薄层：只负责拼命令 + 调一次 `execute_command` ✓） */
async function runGitBatch(cwd: string, commands: string[][]): Promise<Array<{ stdout: string; exitCode: number }>> {
  const body = commands
    .map((args) => `${buildGitCommand(cwd, args)}; Write-Output "${GIT_BATCH_SENTINEL}$LASTEXITCODE"`)
    .join("; ");
  const { invoke } = (window as any).__TAURI__.core;
  const result = await invoke("execute_command", {
    command: body,
    cwd,
    timeout_ms: GIT_TIMEOUT_MS,
  });
  return parseGitBatchOutput(String(result.stdout ?? ""), commands.length);
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
/**
 * **同一回合内复用"改动前快照"** ✓（第 186 波 ✓）—— 见 \`start()\` 顶部的长说明 ✓。
 * 键 = 工作区路径 ✓；\`finalize()\` 之后清掉 ✓（下一回合重新拍 ✓）。
 */
const beforeSnapshotCache = new Map<string, { tree: string; snapshot: WorkingTreeSnapshot }>();
/** 仅判据使用 ✓：真实取快照的次数 / 复用次数（**不靠计时** ✗ —— CI 会抖 ✓）。 */
let snapshotTakenCount = 0;
let snapshotReuseCount = 0;
/**
 * ★ 第 46 波：**因"没有会改工作区的工具跑过"而跳过 finalize 的次数** ✓（只给判据用 ✓）。
 * 它就是为了让"跳过生效了"这件事**可机检** ✓（而不是靠计时 ✗ —— CI 会抖 ✓）。
 */
let skippedFinalizeNoMutation = 0;
export function __fileChangeSnapshotStats(): { taken: number; reused: number; skippedNoMutation: number } {
  const out = { taken: snapshotTakenCount, reused: snapshotReuseCount, skippedNoMutation: skippedFinalizeNoMutation };
  snapshotTakenCount = 0;
  snapshotReuseCount = 0;
  skippedFinalizeNoMutation = 0;
  return out;
}
export function __resetFileChangeSnapshotCache(): void {
  beforeSnapshotCache.clear();
  snapshotTakenCount = 0;
  snapshotReuseCount = 0;
  skippedFinalizeNoMutation = 0;
}

/**
 * **仅判据使用** ✓：直接播种一条缓存 ✓。
 *
 * 为什么需要它 ✗：`start()` 的第一句是 `isGitRepo()` ✓，而它走**宿主 IPC** ✗
 * ⇒ 在 vitest 里恒为 false ✓ ⇒ 拿不到快照、也测不到缓存逻辑 ✗。
 * 播种之后，判据就能**不依赖 git** 地验证"复用"与"失效"两条行为 ✓
 * （与 `MTC-*` 同一思路：测**行为**，不测**计时** ✓）。
 */
export function __seedFileChangeSnapshot(workspace: string, tree: string, snapshot: WorkingTreeSnapshot): void {
  beforeSnapshotCache.set(workspace, { tree, snapshot });
}

/** **仅判据使用** ✓：某工作区当前有没有可复用的快照 ✓（用于验证 `finalize()` 的失效 ✓）。 */
export function __hasFileChangeSnapshot(workspace: string): boolean {
  return beforeSnapshotCache.has(workspace);
}

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
  /**
   * ★ 第 46 波：**三条 git 命令塞进一次 PowerShell** ✓（原来 3 个进程 ≈ 870ms ✗ ⇒ 现在 1 个 ≈ 290ms ✓）。
   * 每条自己的退出码由哨兵带出来 ✓（`parseGitBatchOutput` ✓），所以"命令失败"与
   * "干净工作区导致的空输出"仍然分得开 ✓（前者仍走原来的回退 ✓）。
   */
  const [stashRes, headRes, lsRes] = await runGitBatch(workspace, [
    ["stash", "create"],
    ["rev-parse", "HEAD^{tree}"],
    ["ls-files", "--others", "--exclude-standard"],
  ]);
  /** `stash create` 在干净工作区上输出空且退出码 0 ✓ ⇒ 回退到 HEAD ✓（与原来同口径 ✓） */
  const stashRef = stashRes && stashRes.exitCode === 0 ? stashRes.stdout.trim() : "";
  const headTree = (headRes?.stdout ?? "").trim();
  let untracked: string[] = [];
  if (lsRes && lsRes.exitCode === 0) {
    untracked = lsRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return { ref: stashRef || headTree, clean: !stashRef, untracked };
}

export class FileChangeTracker {
  private workspace: string;
  private beforeTree: string | null = null;
  /** 本轮开始时的**工作区**快照（未提交改动也算，第 84 波） */
  private beforeSnapshot: WorkingTreeSnapshot | null = null;
  private active = false;
  /**
   * ★ 第 46 波：**自上次 `finalize()` 以来，有没有"会改工作区"的工具跑过** ✓。
   *
   * 由 `noteMutation()` 置位 ✓（调用方挂在 `needsPreCallSnapshot(...)` 那条既有钩子上 ✓，
   * 它同时覆盖文件工具与 shell ✓）；`finalize()` 消费并复位 ✓。
   * 未置位 ⇒ `finalize()` **一次 git 都不发** ✓（见那里的长说明 ✓）。
   */
  private mutatedSinceFinalize = false;
  private sessionId: string;
  private messageId: string;
  private turnIndex: number;

  /**
   * ★ 第 46 波：**声明"刚跑过一个会改工作区的工具"** ✓。
   *
   * 保守方向 ✓：**多打标记没有代价** ✓（最多多跑一次 git ✓），
   * 漏打标记才有代价 ✗（那一轮的改动会被漏记 ✓）⇒ 所以调用点用**契约判据** ✓
   * （`needsPreCallSnapshot` ✓ = 改工作区或破坏性 ✓），不按工具名列举 ✗。
   */
  noteMutation(): void {
    this.mutatedSinceFinalize = true;
  }

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
    /**
     * ## 第 186 波：**"改动前快照"每回合只取一次** ✗→✓（目标②的修复 ✓）
     *
     * 真机打点（1.16.278 ✓）把每轮 `prep=` 的 **1.86s** 圈到 `compactionOut → iterT0` 这 124 行 ✓，
     * 逐行列 `await` 后只剩这一处 ✓ —— 而 `agentic-loop.ts` 是**每轮**都
     * `new FileChangeTracker(...)` 再 `await start()` ✗ ⇒ 每轮都跑
     * `rev-parse` + **`git stash create`**（各起一个 git 进程 ✗）⇒ 30–49 轮 ≈ **60–90s** ✓，
     * 与总账完全对上 ✓。
     *
     * 语义上 ✓：`beforeSnapshot` 是 `finalize()` 用来算"**这一回合**新增了什么"的基准 ✓，
     * 所以正确的"改动前"是**回合开始时**的工作区 ✓，而不是每一轮各拍一张 ✗
     * （每轮重拍只会让基准**越拍越晚** ✗，把本轮早期改动算丢 ✗ —— 所以这个缓存**同时修了一个正确性问题** ✓）。
     *
     * 失效 ✓：`finalize()` 结束后清掉 ✓（下一回合重新拍 ✓）；工作区路径变了也重新拍 ✓（按 workspace 作键 ✓）。
     */
    const cached = beforeSnapshotCache.get(this.workspace);
    if (cached) {
      this.beforeTree = cached.tree;
      this.beforeSnapshot = cached.snapshot;
      this.active = true;
      snapshotReuseCount++;
      return true;
    }
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
       *
       * ⚠️ 第 46 波量过、**故意不动** ✓：这里（连同 `isGitRepo`）一共 3 次 `execute_command` ✗，
       * 而 `start()` 只在**每个回合**缓存未命中时跑一次 ✓ —— 合成一次省的 ~0.5s/**回合**
       * 折到一批里只有 **~0.2%** ✗，却要改 3 个夹具 ✗ ⇒ **不划算** ✓。
       * （真正贵的是 `finalize()` —— 它**每迭代**都跑 ✓，那两刀已经落地 ✓。）
       */
      this.beforeSnapshot = await snapshotWorkingTree(this.workspace);
      /** 第 186 波：**存下来给同一回合的后续迭代复用** ✓（见 `start()` 顶部的说明 ✓）。 */
      beforeSnapshotCache.set(this.workspace, { tree: this.beforeTree, snapshot: this.beforeSnapshot });
      snapshotTakenCount++;
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
    /**
     * ★★ 第 46 波：**"没有会改工作区的工具跑过" ⇒ 不必进 git** ✓（治本 ✓ 结构性 ✓）。
     *
     * 现场事实 ✓（读码 + 真机 ✓）：
     *   · `start()` 的 git 成本**早已为 0** ✓（第 188 波：`finalize()` 把 after 写成下一次的 before ✓）
     *   · 所以每迭代剩下的成本就是**这里**：`snapshotWorkingTree()` 一次 git ✗
     *     （实测四类追踪器调用 ~180 次/格 ✓ = exec 的 74–88% ✓，纯开销 ~57s/格 ≈12% 墙钟 ✗）
     *   · 而 `finalize()` 本来就会在"没变化"时返回 `null` ✓（`:440` ✓）——
     *     可它**先付了那次 git** ✗ 才知道没变化 ✓ ⇒ 顺序反了 ✓
     *
     * 修法 ✓：由调用方在**工具真正可能改工作区**时打个标记 ✓（`noteMutation()` ✓，
     *   挂在 `needsPreCallSnapshot(...)` 那条既有钩子上 ✓ —— 它同时覆盖文件工具与 shell ✓）；
     *   这里若**没打过标记** ⇒ 直接返回 `null` ✓，**一次 git 都不发** ✓。
     *
     * 为什么这是安全的 ✓（不是"优化掉正确性"✗）：
     *   · 只有**没有**改工作区的工具跑过时才会跳过 ✓；`bash`/`run_test`/文件工具都会打标记 ✓
     *     （判据来自契约 `needsPreCallSnapshot` ✓，不是按工具名列举 ✗）
     *   · 用户在两轮之间**手改**文件的情况 ✓：那属于"本轮没有工具改过" ⇒ 该轮不记录 ✓，
     *     而**下一轮只要有任何改工作区的工具** ✓ 就会照常对比并记录 ✓（与既有缓存语义一致 ✓）
     * ⇒ ★ 与 DSH 一致 ✓：`dsh-workspace-changes` 也是"只记文件工具的编辑 + 轮次边界快照" ✓，
     *   并明说「快照覆盖范围之外只通过 shell 命令做出的改动**不会被记录**」✓ —— 同一取舍 ✓
     */
    if (!this.mutatedSinceFinalize) {
      this.active = false;
      skippedFinalizeNoMutation++;
      return null;
    }
    this.mutatedSinceFinalize = false;
    this.active = false;

    try {
      const afterSnapshot = await snapshotWorkingTree(this.workspace);
      const afterTree = afterSnapshot.ref;
      /**
       * ## 第 188 波：**"上一次的 after" 就是 "下一次的 before"** ✗→✓（目标②的修复 ✓）
       *
       * 真机打点（1.16.280 ✓）把每轮 `prep` 的 **2.3s** 锁到 `await start()` ✓
       * （`preTrackerCtor → iterT0 = 2345ms` ✓，而这两点之间只有"构造（平凡）+ `start()`" ✓）。
       * 上一波（186）我加过缓存却**没效果** ✗，原因也已查明 ✓：
       * **`finalize()` 每轮都会被调用** ✓（每轮记录一次文件变更 ✓），
       * 而我把"清缓存"放在 `finalize()` 里 ✗ ⇒ 缓存每轮被清 ✗ ⇒ 等于没缓存 ✓。
       *
       * 正确做法 ✓：`finalize()` 刚算出的 `afterSnapshot` **正是下一轮该用的 before** ✓
       * （工作区在两次迭代之间没有别人改动它 ✓）⇒ **直接把它写成缓存** ✓，
       * 下一轮 `start()` 复用 ✓ ⇒ `prep` 里的 git 调用从"每轮 2 次"变成 **0 次** ✓。
       *
       * 正确性 ✓：若用户在迭代之间手改了文件 ✓，那些改动会在**下一轮**的 diff 里出现 ✓
       * （对照的是这里的 after ✓）—— 与原来的行为一致 ✓，只是不再重复拍同一棵树 ✓。
       */
      beforeSnapshotCache.set(this.workspace, { tree: afterTree, snapshot: afterSnapshot });
      snapshotTakenCount++;
      const newUntracked = afterSnapshot.untracked.filter((f) => !this.beforeSnapshot!.untracked.includes(f));

      // 没有任何变化（含"未跟踪文件也没多"）→ 不产生记录
      if (afterTree === this.beforeTree && newUntracked.length === 0) {
        return null;
      }

      /**
       * ★ 第 46 波：`--name-status` 与 `--stat` **合成一次调用** ✓（两条都是纯文本、彼此独立 ✓）。
       * `--binary` 依赖 `--stat` 的预检结果（补丁过大就跳过 ✗）⇒ 必须留在后面**单独**发 ✓。
       * 收益口径：每省一条 git 就省一个 PowerShell 进程 ✓（实测 ~240ms/条 ✗）。
       */
      const [nameStatusRes, statRes] = await runGitBatch(this.workspace, [
        ["diff", "--name-status", this.beforeTree, afterTree],
        ["diff", "--stat", this.beforeTree, afterTree],
      ]);
      const nameStatus = nameStatusRes?.stdout ?? "";

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
        const statOutput = statRes?.stdout ?? "";
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
    /**
     * 第 269 波：这张表**不再有域镜像** ✗→✓（按需查询 + 有界一屏 ✓），
     * 所以读记录也改成**按需** ✓（`getByIdAsync` ✓）。
     *
     * ⚠️ 这里**不能**用删掉的那个同步 `getById()` ✗：它读的是"一屏投影"，
     * 没读过就是**空** ✗ —— 那会把"**没缓存**"说成"**这行不存在**"✗，
     * 用户看到的就是"这条变更记录不存在（可能随会话被清理）"✗ 这种**假结论** ✗
     * （`persist-domain-fixes.test.ts` C7-2 钉的正是这条区分 ✓）。
     *
     * 三态仍然分开 ✓（判据 C7-2 / C7-1b 守着 ✓）：
     * 记录不存在（业务失败 ✓）/ 记录在但 patch 缺失（业务失败 ✓）/
     * 存储没接手或命令失败（**可重试**失败 ✓）。
     */
    let record: Awaited<ReturnType<typeof FileChangeStorage.getByIdAsync>> = null;
    let readError: unknown = null;
    try {
      record = await FileChangeStorage.getByIdAsync(artifactId);
    } catch (e) {
      readError = e;
    }
    if (!record) {
      /*
       * ⚠️ 不能把 `null` 直接说成"没有这条记录"：按需读**失败**（端口没注册 /
       * 命令抛错）与"引擎说这行不在"是两件事，对用户的意义完全不同。
       */
      if (!hasStoragePort()) {
        // 第 100 轮分诊：**回滚这个动作没执行**（读不到记录），不是"写盘失败" ⇒ action。
        reportActionFailure(
          "fileChange.revert",
          new Error("端口未注册（本进程没有可用存储）"),
          `回滚未执行：读不到变更记录 ${artifactId}，请稍后重试`,
        );
      } else if (readError) {
        reportActionFailure(
          "fileChange.revert",
          readError,
          `回滚未执行：读取变更记录 ${artifactId} 失败，请稍后重试`,
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
        // 第 100 轮分诊：同样是"回滚动作没执行"（补丁正文取不到）⇒ action。
        reportActionFailure("fileChange.revert", fetched.error, `回滚未执行：补丁正文本次取不到，请稍后重试`);
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
      // 第 269 波：接口改成按需读 + 写回，返回值的**含义一字不变**（1 = 真改到了，0 = 那行不在）。
      const statusRows = await FileChangeStorage.updateStatus(artifactId, "reverted");
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
