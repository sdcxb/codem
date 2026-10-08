/**
 * 统一文件 API 适配层（Tauri 模式）
 * 所有文件操作通过 Tauri IPC 调用 Rust 命令
 */

const isTauri = () => !!(window as any).__TAURI__;

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(command, args);
}

export async function getDefaultCwd(): Promise<string> {
  return tauriInvoke("get_default_cwd");
}

/** 获取 app data 目录（用户配置/安装路径，非工作目录） */
export async function getAppDataDir(): Promise<string> {
  return tauriInvoke("get_app_data_dir");
}

// ========== File Operations ==========

/**
 * 相对路径按工作区解析（**同一套**判定的一部分）。
 *
 * ## 为什么必须解析，而且必须用解析后的路径去做 I/O
 *
 * 判据与动作必须是同一个路径。Rust 侧的 `resolve_sandbox_path`（`lib.rs:985`）对
 * **相对路径**是按**进程 cwd** canonicalize 的 —— 所以「检查用工作区解析、写盘用原样相对路径」
 * 会出现"检查通过、文件落到别处"的错位（比不检查更糟）。因此这里解析之后，
 * **调用方必须拿解析结果去做 IPC**（`readFile` / `globSearch` / `grepSearch` / `writeFile`
 * 都照此办理）。
 *
 * 语义与 `tools.ts:222-223` 的 `checkSandbox` + `resolvePath` 一致（那儿早就这么做了）：
 * 相对路径按工作区解析，`..` 逃逸解析后仍然在外面 ⇒ 照旧被拒。
 */
function resolveAgainstWorkspace(path: string, workspace: string | undefined): string {
  if (!workspace) return path;
  // "." 就是工作区本身（别拼成 `…/.`：检查与动作都更干净）
  if (path === ".") return workspace;
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")) return path;
  const sep = workspace.includes("/") && !workspace.includes("\\") ? "/" : "\\";
  return workspace.replace(/[\\/]+$/, "") + sep + path.replace(/^[\\/]+/, "");
}

/**
 * ★ 第 185 波（复审 R1-4d）：**能 canonicalize 就 canonicalize**。
 *
 * `isPathWithinWorkspace` 是纯词法的（同步、不碰磁盘）。词法判定挡得住
 * `C:\mimo-gui-backup` 这类前缀兄弟，却挡不住"工作区里一个指向外部的 junction/符号链接"
 * —— 而 Rust 侧（`lib.rs:985` 的 `resolve_sandbox_path` + `:1037` 的 `path_within_workspace`）
 * 已经改成真 `canonicalize` 了。同一事实两份实现、两个结论，正是本仓库最忌讳的形态。
 *
 * 所以这里：宿主可用时直接问 Rust 的 `check_path_in_workspace`（**与写侧守卫同一份实现**，
 * 它自己会 canonicalize + 剥 `\\?\` + 按组件比较）；命令不可用（旧构建 / 非 Tauri 宿主 /
 * 单测）才退回**词法**判定（与 Rust 的 `lexical_normalize` 同口径）—— 两个方向都是"判定"，
 * 没有"跳过检查"这一支。
 */
async function resolveWithinWorkspace(target: string, workspace: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const ok = await tauriInvoke("check_path_in_workspace", { path: target, workspace });
      if (typeof ok === "boolean") return ok;
    } catch {
      // 命令不存在/调用失败 ⇒ 退回词法判定（**不是**放行）
    }
  }
  return isPathWithinWorkspace(target, workspace);
}

/**
 * ★ 第 185 波（T2）：**读侧的工作区判定** —— 与写侧（`writeFile`）**同一份实现**。
 *
 * ## 为什么必须补（这是真机事故的同一形态）
 *
 * `writeFile` 早就有 `options.workspace` 的沙箱检查（S5），而 `readFile` / `globSearch` /
 * `grepSearch` **没有**：同一个沙箱里「带 `path` 的 `read` 工具调用会被 `SandboxGuard` 拒」，
 * 而 `run_code` / `workflow` 里的 `sdk.read("C:/Users/x/.ssh/id_rsa")` 照样读得到
 * （它们直接调这里的裸 IPC）。`tool-gates.ts` 只覆盖危险命令 / 受保护**写**路径 / 覆盖确认，
 * 没有读侧闸门 ⇒ 越界读留下的是「成绩作废」级别的事故（见 `tools.ts` 记的那条真机记录）。
 *
 * ## 口径（与写侧一致，只有动词不同）
 *
 * - `workspace` 未给 ⇒ 不做判定。应用自管的读写（设置、日志、溢出文件、快照、技能目录）
 *   本来就不在工作区内，且它们不走工具路径 —— 这是**既有语义**，不是本轮新开的口子；
 * - `workspace` 给了而目标在外 ⇒ **抛错**（如实失败）。绝不 catch 之后继续：
 *   那等于「看起来有沙箱、实际没检查」，比没有更糟。
 *
 * 判据见 `src/test/run-code-sdk-sandbox-read.test.ts`。
 */
async function assertWithinWorkspace(verb: string, target: string, workspace: string | undefined): Promise<void> {
  if (!workspace) return;
  if (await resolveWithinWorkspace(target, workspace)) return;
  throw new Error(
    `Sandbox: ${verb} "${target}" is outside the workspace "${workspace}". ` +
    `The sandbox restricts file access to the workspace directory and its subdirectories.`,
  );
}

export async function readFile(path: string, options?: { workspace?: string }): Promise<string> {
  // ★ 第 185 波（T2）：读侧沙箱。原来是裸 IPC —— `sdk.read` 因此是整条链上
  // 唯一没有工作区判定的文件读入口。
  // 相对路径先按工作区解析：**检查与读取必须是同一个路径**（见 resolveAgainstWorkspace）。
  const target = resolveAgainstWorkspace(path, options?.workspace);
  await assertWithinWorkspace("Read from", target, options?.workspace);
  return tauriInvoke("read_file", { path: target });
}

/**
 * 整读失败的**机器可读判据**：Rust 侧超限时返回以 `E_FILE_TOO_LARGE:` 开头的错误。
 *
 * 为什么要有稳定前缀：会话的权威副本（`sessions/<id>.jsonl`）会随对话长到几百 MB，
 * 而整读日志的调用方需要**判断"该切分窗读取了"还是"真的读不到"** ——
 * 靠错误文本里有没有 "File is large" 这种自然语言判据太脆（改一个词就静默失效），
 * 所以 Rust 侧改成一个稳定的错误码前缀（见 `src-tauri/src/lib.rs::read_file`）。
 */
export const ERR_FILE_TOO_LARGE = "E_FILE_TOO_LARGE:";

/** 这个错误是不是"文件太大、整读被护栏挡住"（⇒ 应当改走分窗读取） */
export function isFileTooLargeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes(ERR_FILE_TOO_LARGE);
}

/** 分窗读取的返回体（对应 Rust `read_text_window`） */
export interface TextWindow {
  /** 本次返回的文本，**只含完整行**（除文件末尾未换行的最后一行） */
  text: string;
  /** 下一次调用应传的 offset（总是指向行首） */
  nextOffset: number;
  /** 是否已到文件末尾 */
  eof: boolean;
  /** 文件总字节数 */
  size: number;
}

/**
 * 分窗读取文本文件（Rust `read_text_window`，**行对齐**）。
 *
 * 用途：读**可能极大**的文本文件（本项目的权威会话日志）。`readFile` 有 50 MB 上限，
 * 那是给"整读源文件"用的护栏；600 MB 的日志既不该一次性进 JS 堆，也不该变成"读不到"。
 *
 * @param offset   起始字节位置（必须是行首：用上一次返回的 `nextOffset`）
 * @param maxBytes 单次窗口上限（Rust 侧夹到 64 KB ~ 8 MB）
 */
export async function readTextWindow(
  path: string,
  offset = 0,
  maxBytes?: number,
  /**
   * ★ 第 185 波（复审 R1-4/I-2）：**与 `readFile` 同一个读侧沙箱口径**。
   *
   * 分窗读取是"读同一个文件的另一条路"：只堵整读、不堵分窗，等于把同一个绕过口
   * 留在隔壁（真实的调用方会先试分窗、失败再退回整读 —— 见 `task-keyword-search.ts`）。
   */
  options?: { workspace?: string },
): Promise<TextWindow> {
  const target = resolveAgainstWorkspace(path, options?.workspace);
  await assertWithinWorkspace("Read from", target, options?.workspace);
  return tauriInvoke("read_text_window", { path: target, offset, maxBytes });
}

/** Result of a paginated file read via read_file_lines. */
export interface ReadFileLinesResult {
  /** The numbered text (lines with "N: " prefix, joined by \n). */
  text: string;
  /** Total number of lines in the file. */
  totalLines: number;
  /** Whether there are more lines after the returned range. */
  hasMore: boolean;
  /**
   * 第 181 波（T-3，对标 Pi `cdf79797b`）：**没被返回的行数**。
   *
   * 与 `text` 出自 Rust 侧**同一次遍历**，所以两者一定自洽（不是分两次扫出来的估值）。
   * 含两种情况：被 `offset` 跳过的行、以及超出 `limit`/`maxChars` 的行。
   * 有一句"还有更多行"是不够的 —— 模型得知道"还差 3 行"还是"还差 3 万行"，
   * 才决定该继续翻页还是改用 grep/bash。
   */
  droppedLines: number;
  /** 未返回部分的字符数（不含 "N: " 行号前缀） */
  droppedChars: number;
}

/**
 * Read a file with line-level pagination (calls Rust `read_file_lines`).
 * Only the requested [offset, offset+limit) lines are loaded into memory.
 * Use this for any large file — the full file is never transferred through IPC.
 *
 * @param path     File path to read.
 * @param offset   1-indexed line number to start from (default: 1).
 * @param limit    Maximum lines to read (default: 2000).
 * @param maxChars Hard cap on output length in chars (default: 100000).
 */
export async function readFileLines(
  path: string,
  offset?: number,
  limit?: number,
  maxChars?: number,
): Promise<ReadFileLinesResult> {
  return tauriInvoke("read_file_lines", { path, offset, limit, maxChars });
}

/**
 * `Uint8Array` → base64（**逐字节**，不经过 UTF-8 解码）。
 *
 * ## 为什么要有它（第 184 波 F3）
 *
 * 技能安装路径（`skill/installer.ts` / `skill/skill-market-client.ts`）原来对**二进制**
 * 资源也走 `strFromU8(bytes)`（UTF-8 解码）+ 文本 `writeFile` —— 白名单里明明有
 * `.png/.jpg/.gif/.ico`，而 UTF-8 解码会把非法字节序列替换成 U+FFFD，
 * 于是**图标字节被静默破坏**（SKILL.md 里引用的资源读出来是乱码）。
 *
 * 正确形态是 `writeFile(path, base64, { encoding: "base64" })`（见 `writeFile` 的 `encoding`
 * 与 `mcp-resources-tool.ts` 的既有用法），本函数负责那一步的编码。
 *
 * 分块拼接：`String.fromCharCode(...bytes)` 对大文件会因参数个数上限抛
 * `RangeError: Maximum call stack size exceeded`，所以按 32KB 分块。
 */
export function u8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function writeFile(path: string, content: string, options?: { encoding?: string; workspace?: string }): Promise<void> {
  // S5: Frontend sandbox check — reject writes outside workspace before hitting Rust backend
  // ★ 第 185 波（T2）：与 `readFile` / `globSearch` / `grepSearch` 共用**同一份**判定
  // （原来是这里内联的一段，读侧要复刻就只能再写一份 —— 那正是漂移的来源）。
  // 相对路径同样先按工作区解析，并且**用解析结果去写盘**（否则检查与动作不是同一个路径）。
  const target = resolveAgainstWorkspace(path, options?.workspace);
  await assertWithinWorkspace("Write to", target, options?.workspace);
  await tauriInvoke("write_file", { path: target, content, encoding: options?.encoding, workspace: options?.workspace });
}

/**
 * ★ 第 185 波（复审 R1-4d）：**与 Rust 侧同口径**的读/写工作区判定。
 *
 * ## 为什么不能只是"字符串前缀"
 *
 * Rust 侧（`lib.rs:1037` 的 `path_within_workspace`）已经改成：
 * **真 `canonicalize`**（`:985` 的 `resolve_sandbox_path`，含"路径不存在时规范化最近的
 * 已存在祖先"）＋ 剥 `\\?\` 前缀（`:939`）＋ **按分量**比较 ＋ Windows 大小写折叠（`:1017`）。
 * 改前这里只有一份**词法**实现 ⇒ 同一事实两份结论：
 * · 工作区里一个指向外部的 junction / 符号链接：写侧拒（canonicalize 后在外面），读侧放行；
 * · `\\?\C:\ws\x` 这种形式：两侧也会得出相反结论。
 *
 * 现在这里的**词法**分支逐条对齐 Rust 的 `lexical_normalize` + `component_fold` +
 * `path_within_workspace`（分量比较、分隔符边界、大小写折叠、剥 verbatim 前缀）；
 * 需要"真 canonicalize"时由 `resolveWithinWorkspace` 问 Rust 的
 * `check_path_in_workspace`（**与写侧守卫同一份实现**）。
 */
export function isPathWithinWorkspace(targetPath: string, workspace: string): boolean {
  const normalizedTarget = pathComponents(targetPath);
  const normalizedWorkspace = pathComponents(workspace);

  // 两边都空 ⇒ 相等（与改前同形；空工作区本来就不做检查 —— 见 assertWithinWorkspace 的前置条件）
  if (normalizedWorkspace.length === 0) return normalizedTarget.length === 0;
  if (normalizedTarget.length < normalizedWorkspace.length) return false;
  // **逐分量**比较：`c:\mimo-gui-backup` ≠ `c:\mimo-gui`（字符串前缀会误放行）
  return normalizedWorkspace.every((seg, i) => normalizedTarget[i] === seg);
}

/** 是否按 Windows 路径语义比较（大小写不敏感）—— 对照 Rust 的 `cfg!(target_os = "windows")` */
const CASE_INSENSITIVE_PATHS: boolean = (() => {
  try {
    if (typeof process !== "undefined" && process.platform) return process.platform === "win32";
  } catch {
    /* 宿主没有 process ⇒ 走下面的兜底 */
  }
  if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
    return /Windows/i.test(navigator.userAgent);
  }
  return true; // 本产品只在 Windows 桌面端跑
})();

/**
 * 路径 → **可比较的分量序列**（与 Rust `lexical_normalize` 同形）：
 * 去 `.`、词法折叠 `..`（退到根时丢弃 —— 与 Rust 一样不可能再匹配到工作区前缀）、
 * 剥 `\\?\` / `\\?\UNC\` verbatim 前缀（`strip_verbatim_prefix`）、
 * 反斜杠归一、Windows 下折叠大小写（`component_fold`）。
 */
function pathComponents(p: string): string[] {
  return String(p ?? "")
    .replace(/\//g, "\\")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .split("\\")
    .filter((seg) => seg !== "" && seg !== ".")
    .reduce<string[]>((acc, seg) => {
      if (seg === "..") {
        acc.pop();
      } else {
        acc.push(CASE_INSENSITIVE_PATHS ? seg.toLowerCase() : seg);
      }
      return acc;
    }, []);
}

export async function listDirectory(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  return tauriInvoke("list_directory", { path });
}

export async function deleteFile(path: string): Promise<void> {
  await tauriInvoke("delete_file", { path });
}

export async function deletePath(path: string): Promise<void> {
  // 先尝试删文件，失败再尝试删目录
  try {
    await tauriInvoke("delete_file", { path });
  } catch {
    await tauriInvoke("delete_directory", { path });
  }
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  await tauriInvoke("rename_file", { oldPath, newPath });
}

/**
 * 文件**版本令牌**（`<size>:<mtime_nanos>`）；文件不存在返回 `null`。
 *
 * 第 95 波：`fs-observation-policy` 的 CAS 依据 —— "你读到的" 与 "现在盘上的" 是不是同一版。
 * 为什么用元数据而不是内容哈希、以及它的已知边界，见 `src-tauri/src/lib.rs::file_version_impl`。
 *
 * ⚠️ **语义边界（很重要）**：`null` 表示"**确认不存在**"。而"读不到"（IPC 不可用 / 权限 / 命令没注册）
 * 会**照原样抛出**，不吞成 `null` —— 本仓库的既有纪律：**读不到 ≠ 没有数据**。
 * 调用方（`fs-observation-policy` 的工具层）用 `undefined` 表示第三种状态"**不知道**"，
 * 并对它做退化的、有据可查的处置（见 `tools.ts` 的 `currentVersionOrUnknown`）。
 */
export async function fileVersion(path: string): Promise<string | null> {
  const v = await tauriInvoke("file_version", { path });
  return typeof v === "string" ? v : null;
}

/**
 * 追加一行文本到文件（不存在则创建，含父目录）。用于诊断轨迹落盘：
 * 追加比整文件重写便宜，也不会因为写一半崩掉而丢掉已有线索。
 */
export async function appendFile(path: string, content: string): Promise<void> {
  await tauriInvoke("append_file", { path, content });
}

/**
 * 递归永久删除目录（不进回收站、不弹任何系统对话框）。
 *
 * 用于**应用自管目录**（已安装技能、宠物、下载的运行时/模型）：这些目录删掉只是重新下载，
 * 回收站不提供额外安全价值，而任何"可能弹对话框"的删除路径都可能永远卡住 —— 曾经的
 * `delete_directory`（PowerShell + `OnlyErrorDialogs` + 回收站）就会在错误对话框无人可点时
 * 无限等待，表现为界面上「删除技能」卡死。
 */
export async function deleteDirectoryPermanent(path: string): Promise<void> {
  await tauriInvoke("delete_directory_permanent", { path });
}

export async function exists(path: string): Promise<boolean> {
  try {
    return await tauriInvoke("path_exists", { path });
  } catch {
    // Fallback: use PowerShell Test-Path (execute_command always wraps in PowerShell)
    try {
      const result = await executeCommand(`Test-Path -LiteralPath '${path.replace(/'/g, "''")}'`);
      return result.stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  }
}

export async function executeCommand(command: string, cwd?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  // FIX(对标 dsh): pass timeout_ms so Rust kills the process tree on timeout —
  // previously the frontend Promise.race abandoned the promise while the
  // PowerShell child kept running (zombie processes on repeated timeouts).
  return tauriInvoke("execute_command", { command, cwd, timeout_ms: timeoutMs });
}

/**
 * 搜索路径的沙箱判定（glob / grep 共用）—— 与 `readFile` / `writeFile` 同一份实现。
 *
 * ★ 第 185 波（T2）：`sdk.glob("*.ts", "C:/other")` / `sdk.grep(p, { path: "C:/other" })`
 * 原来直接落到 Rust 的 `glob_search` / PowerShell 的 `Get-ChildItem -Path`，
 * 沙箱开启时照样扫描工作区外 —— 与 `sdk.read` 是同一个缺口。
 *
 * @returns 判定通过的**绝对**搜索路径（`workspace` 未给时原样返回）；
 *   调用方必须拿它去做真正的搜索 —— 检查与动作要是同一个路径。
 */
async function checkSearchPathWithinWorkspace(
  searchPath: string,
  workspace: string | undefined,
): Promise<string> {
  const target = resolveAgainstWorkspace(searchPath, workspace);
  await assertWithinWorkspace("Search in", target, workspace);
  return target;
}

export async function globSearch(
  pattern: string,
  path?: string,
  options?: { workspace?: string },
): Promise<string[]> {
  // ★ 第 185 波（T2）：给了 workspace 时，"." 与省略 path 都以**工作区**为基准
  // （不是进程默认 cwd —— 否则 `sdk.glob(p, ".")` 会被解析到一个工作区外的目录、
  //  然后被沙箱如实拒绝：**假失败**）。
  let searchPath = path || options?.workspace || await getDefaultCwd();

  // Resolve relative paths
  if (searchPath === ".") {
    searchPath = options?.workspace ?? await getDefaultCwd();
  }

  // ★ 第 185 波（T2）：搜索路径与**模式**都要过工作区判定。
  // 只判搜索路径是不够的：`glob("../..//*.ts", workspace)` 的 `..` 在模式里，
  // 由 Rust 侧拼接后照样跑出工作区。模式判据只认**绝对路径**与含 `..` 的形态
  // （普通 glob 通配符不受影响），判不准的方向是"拦下"（保守），不是"放行"。
  searchPath = await checkSearchPathWithinWorkspace(searchPath, options?.workspace);
  await assertGlobPatternWithinWorkspace(pattern, searchPath, options?.workspace);

  const winPattern = pattern.replace(/\//g, '\\');
  console.log("[globSearch] calling Rust glob_search:", { pattern: winPattern, path: searchPath, originalPath: path });
  
  // Add timeout to prevent hanging
  const timeoutPromise = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error("glob_search timed out")), 30000)
  );
  const result = await Promise.race([
    tauriInvoke("glob_search", { pattern: winPattern, path: searchPath }),
    timeoutPromise
  ]);
  console.log("[globSearch] result length:", result.length);
  return result;
}

/**
 * glob **模式**里的越界形态（绝对路径 / 含 `..`）。
 *
 * 为什么只对 glob 做、不对 grep 做：grep 的 `pattern` 是 PowerShell **正则**，
 * `..`（任意两字符）是常见写法，拿路径规则去判它必然误杀合法检索。
 * glob 的 `pattern` 本身就是路径表达式 ⇒ 同一个判据在这里语义正确。
 */
async function assertGlobPatternWithinWorkspace(
  pattern: string,
  searchPath: string,
  workspace: string | undefined,
): Promise<void> {
  if (!workspace) return;
  const p = pattern.replace(/\\/g, "/");
  const absolute = /^[A-Za-z]:\//.test(p) || p.startsWith("//") || p.startsWith("/");
  if (!absolute && !p.split("/").includes("..")) return;
  const base = searchPath.replace(/\\/g, "/").replace(/\/+$/, "");
  await assertWithinWorkspace("Glob pattern", absolute ? p : `${base}/${p}`, workspace);
}

/**
 * @param include 文件名过滤（可给多个 ✓，PowerShell `-Include` 的数组形式 ✓）。
 *   ★ 第 43 波：允许**数组** —— 调用方要"只扫判据文件"时必须能一次给 `*test*` 与 `*spec*` ✓
 *   （只给 `*test*` 会**漏掉** `*.spec.ts` ✗，而 `isTestFile` 是认 spec 的 ✓）。
 */
export async function grepSearch(
  pattern: string,
  path?: string,
  include?: string | string[],
  options?: { workspace?: string },
): Promise<string[]> {
  // Use PowerShell for better Unicode support
  // ★ 第 185 波（T2）：给了 workspace 时，省略 path 以**工作区**为基准（理由同 globSearch）。
  let searchPath = path || options?.workspace || await getDefaultCwd();
  // ★ 第 185 波（T2）：与 `sdk.read` / `sdk.glob` 同一个读侧沙箱判定，并**用解析后的路径**去搜索
  // （`pattern` 是正则、不做路径判定 —— 理由见 `assertGlobPatternWithinWorkspace` 的说明）。
  searchPath = await checkSearchPathWithinWorkspace(searchPath, options?.workspace);
  /**
   * 第 84 波（A/B 类：静默空结果被当成"没有匹配"）：
   *
   * 底层命令里的 `Get-ChildItem … -ErrorAction SilentlyContinue` 会把"路径不存在"
   * 这类错误一并吞掉，管道仍然成功（退出码 0）、stdout 为空 —— 调用方拿到 `[]`
   * 只会以为"文件里没有这个符号"。`lsp` 工具因此会给出**假否定**：
   * "No definition found for X"，而实际上它连目录都没读成。
   *
   * 现在：搜索路径不存在 → 抛错（调用方负责转成明确的错误信息）；
   * 命令非零退出 → 抛错并带上 stderr。
   */
  let pathExists = true;
  try {
    pathExists = await exists(searchPath);
  } catch {
    // 存在性检查本身不可用（缺少 Tauri 命令等）—— 不要让它变成新的故障点
    pathExists = true;
  }
  if (!pathExists) {
    throw new Error(`搜索路径不存在：${searchPath}（grep 未执行，这不代表"没有匹配"）`);
  }

  // Escape single quotes for PowerShell (single quote → double single quotes)
  const safePath = searchPath.replace(/'/g, "''");
  const safePattern = pattern.replace(/'/g, "''");
  const includeList = include === undefined ? [] : Array.isArray(include) ? include : [include];
  const filterArg = includeList.length
    ? `-Include ${includeList.map((g) => `'${String(g).replace(/'/g, "''")}'`).join(",")}`
    : "";
  // Use -AllMatches to support regex (Select-String default is regex, not simple match)
  // PowerShell Select-String supports regex natively and handles Unicode patterns
  const psCommand = `Get-ChildItem -Path '${safePath}' ${filterArg} -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${safePattern}' | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line }`;
  // Rust execute_command 统一用 PowerShell 执行（lib.rs 总是 Command::new("powershell")）。
  // 这里不再包 powershell -Command "..."，否则外层双引号让 PowerShell 把整段命令当作
  // 字符串字面量解析，$_ 在无管道上下文展开为 $null，grep 静默返回空输出。
  const cmd = psCommand;
  console.log("[grepSearch] cmd:", cmd);
  const result = await executeCommand(cmd);
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    const stderr = (result.stderr || "").trim().slice(0, 300);
    throw new Error(`grep 命令失败（exit ${result.exitCode}）${stderr ? `：${stderr}` : ""}`);
  }
  return result.stdout.split("\n").filter(line => line.trim() !== "");
}

// ========== Dialog Operations ==========

export async function openFolderPicker(): Promise<string | null> {
  try {
    const result = await tauriInvoke("open_folder_dialog");
    return result || null;
  } catch (e) {
    console.error("Folder picker error:", e);
    return null;
  }
}
