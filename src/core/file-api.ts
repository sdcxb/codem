/**
 * 统一文件 API 适配层
 * Tauri 模式：直接调用 Rust 命令
 * 浏览器模式：回退到 HTTP API
 */

const isTauri = () => !!(window as any).__TAURI__;

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(command, args);
}

// ========== File Operations ==========

export async function readFile(path: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke("read_file", { path });
  }
  const res = await fetch(`http://localhost:3002/api/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to read file: ${res.status}`);
  return res.text();
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("write_file", { path, content });
  } else {
    const res = await fetch("http://localhost:3002/api/write-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    if (!res.ok) throw new Error(`Failed to write file: ${res.status}`);
  }
}

export async function listDirectory(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  if (isTauri()) {
    return tauriInvoke("list_directory", { path });
  }
  const res = await fetch(`http://localhost:3002/api/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to list directory: ${res.status}`);
  return res.json();
}

export async function deletePath(path: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("delete_directory", { path });
  } else {
    // Browser mode: can't delete files
    throw new Error("Delete not supported in browser mode");
  }
}

export async function executeCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  if (isTauri()) {
    return tauriInvoke("execute_command", { command, cwd });
  }
  const res = await fetch("http://localhost:3002/api/bash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, cwd }),
  });
  if (!res.ok) throw new Error(`Failed to execute command: ${res.status}`);
  return res.json();
}

export async function globSearch(pattern: string, path?: string): Promise<string[]> {
  if (isTauri()) {
    // Use executeCommand for glob in Tauri mode
    const cmd = `dir /s /b "${pattern}"`;
    const result = await executeCommand(cmd, path);
    return result.stdout.split("\n").filter(Boolean);
  }
  const res = await fetch(`http://localhost:3002/api/glob?pattern=${encodeURIComponent(pattern)}&path=${encodeURIComponent(path || ".")}`);
  if (!res.ok) throw new Error(`Glob search failed: ${res.status}`);
  const data = await res.json();
  return data.files || [];
}

export async function grepSearch(pattern: string, path?: string, include?: string): Promise<string[]> {
  if (isTauri()) {
    // Use findstr for grep in Tauri mode
    const includeArg = include ? `/M "${include}"` : "";
    const cmd = `findstr /R /S "${pattern}" "${path || "."}\\*" ${includeArg}`;
    const result = await executeCommand(cmd, path);
    return result.stdout.split("\n").filter(Boolean);
  }
  const params = new URLSearchParams({ pattern, path: path || "." });
  if (include) params.set("include", include);
  const res = await fetch(`http://localhost:3002/api/grep?${params}`);
  if (!res.ok) throw new Error(`Grep search failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// ========== Dialog Operations ==========

export async function openFolderPicker(): Promise<string | null> {
  if (isTauri()) {
    try {
      const result = await tauriInvoke("open_folder_dialog");
      return result || null;
    } catch (e) {
      console.error("Folder picker error:", e);
      return null;
    }
  }
  return null;
}
