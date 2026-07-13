/**
 * 统一文件 API 适配层（Tauri 模式）
 * 所有文件操作通过 Tauri IPC 调用 Rust 命令
 */

const isTauri = () => !!(window as any).__TAURI__;

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(command, args);
}

async function getDefaultCwd(): Promise<string> {
  return tauriInvoke("get_default_cwd");
}

// ========== File Operations ==========

export async function readFile(path: string): Promise<string> {
  return tauriInvoke("read_file", { path });
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
  const cmd = `powershell -Command "${psCommand}"`;
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
