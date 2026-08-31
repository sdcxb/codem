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

export async function deletePath(path: string): Promise<void> {
  // 先尝试删文件，失败再尝试删目录
  try {
    await tauriInvoke("delete_file", { path });
  } catch {
    await tauriInvoke("delete_directory", { path });
  }
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

export async function executeCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  return tauriInvoke("execute_command", { command, cwd });
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
