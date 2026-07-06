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

export async function writeFile(path: string, content: string): Promise<void> {
  await tauriInvoke("write_file", { path, content });
}

export async function listDirectory(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  return tauriInvoke("list_directory", { path });
}

export async function deletePath(path: string): Promise<void> {
  await tauriInvoke("delete_directory", { path });
}

export async function executeCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
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
  const filterArg = include ? `-Include '${include}'` : "";
  const psCommand = `Get-ChildItem -Path '${searchPath}' ${filterArg} -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${pattern}' -SimpleMatch | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line }`;
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
