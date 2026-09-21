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

export async function readFile(path: string): Promise<string> {
  return tauriInvoke("read_file", { path });
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
): Promise<TextWindow> {
  return tauriInvoke("read_text_window", { path, offset, maxBytes });
}

/** Result of a paginated file read via read_file_lines. */
export interface ReadFileLinesResult {
  /** The numbered text (lines with "N: " prefix, joined by \n). */
  text: string;
  /** Total number of lines in the file. */
  totalLines: number;
  /** Whether there are more lines after the returned range. */
  hasMore: boolean;
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

export async function writeFile(path: string, content: string, options?: { encoding?: string; workspace?: string }): Promise<void> {
  // S5: Frontend sandbox check — reject writes outside workspace before hitting Rust backend
  if (options?.workspace) {
    if (!isPathWithinWorkspace(path, options.workspace)) {
      throw new Error(
        `Sandbox: Write to "${path}" is outside the workspace "${options.workspace}". ` +
        `The sandbox restricts file writes to the workspace directory and its subdirectories.`
      );
    }
  }
  await tauriInvoke("write_file", { path, content, encoding: options?.encoding, workspace: options?.workspace });
}

/**
 * S5: Check if a path is within the workspace directory.
 * Normalizes both paths and checks if the target starts with the workspace prefix.
 */
export function isPathWithinWorkspace(targetPath: string, workspace: string): boolean {
  const normalize = (p: string): string => {
    return p
      .replace(/\//g, "\\")
      .split("\\")
      .filter((seg) => seg !== "" && seg !== ".")
      .reduce<string[]>((acc, seg) => {
        if (seg === "..") {
          acc.pop();
        } else {
          acc.push(seg);
        }
        return acc;
      }, [])
      .join("\\")
      .toLowerCase();
  };

  const normalizedTarget = normalize(targetPath);
  const normalizedWorkspace = normalize(workspace);

  // The target must be the workspace itself or a subdirectory/file within it
  return (
    normalizedTarget === normalizedWorkspace ||
    normalizedTarget.startsWith(normalizedWorkspace + "\\")
  );
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

export async function globSearch(pattern: string, path?: string): Promise<string[]> {
  let searchPath = path || await getDefaultCwd();
  
  // Resolve relative paths
  if (searchPath === ".") {
    searchPath = await getDefaultCwd();
  }
  
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

export async function grepSearch(pattern: string, path?: string, include?: string): Promise<string[]> {
  // Use PowerShell for better Unicode support
  const searchPath = path || await getDefaultCwd();
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
  const safeInclude = include ? include.replace(/'/g, "''") : "";
  const filterArg = safeInclude ? `-Include '${safeInclude}'` : "";
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
