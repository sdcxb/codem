/**
 * file-mention — @提及文件列表辅助函数
 *
 * 从文件系统递归列出文件，用于 @mention 自动补全
 */

export interface FileMentionItem {
  id: string;
  type: "file" | "folder";
  label: string;
  path: string;
}

// === Types ===

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

// === Directory listing for @mention ===

const MAX_FILES = 200;
const MAX_DEPTH = 4;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".cache", ".tauri", "target", ".vscode", ".idea", "vendor",
  "venv", ".venv", "env", ".env", ".wecode-ref", ".codex",
]);

/**
 * Recursively collect files from a directory tree for @mention.
 * Uses the same Tauri list_directory command as FileExplorer.
 */
export async function listFilesForMention(cwd: string): Promise<FileMentionItem[]> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const entries = await invoke("list_directory", { path: cwd });
    return collectFiles(entries || [], cwd, 0);
  } catch {
    return [];
  }
}

function collectFiles(
  entries: FileEntry[],
  cwd: string,
  depth: number
): FileMentionItem[] {
  if (depth >= MAX_DEPTH) return [];
  const results: FileMentionItem[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results.push({
        id: `folder-${entry.path}`,
        type: "folder",
        label: entry.name,
        path: entry.path,
      });
      if (entry.children) {
        results.push(...collectFiles(entry.children, cwd, depth + 1));
      } else {
        // Lazy-load children asynchronously in the background
        // For now, just list the directory name itself
      }
    } else {
      results.push({
        id: `file-${entry.path}`,
        type: "file",
        label: entry.name,
        path: entry.path,
      });
    }
    if (results.length >= MAX_FILES) break;
  }

  return results;
}

/**
 * Async load a specific directory's children for deeper @mention results.
 */
export async function loadChildrenForMention(dirPath: string): Promise<FileMentionItem[]> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const entries = await invoke("list_directory", { path: dirPath });
    return collectFiles(entries || [], dirPath, 0);
  } catch {
    return [];
  }
}

/**
 * Get a short relative path for display.
 * e.g. /home/user/project/src/index.ts → src/index.ts
 */
export function getRelativePath(fullPath: string, cwd: string): string {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFull = fullPath.replace(/\\/g, "/");
  if (normalizedFull.startsWith(normalizedCwd + "/")) {
    return normalizedFull.substring(normalizedCwd.length + 1);
  }
  return fullPath;
}
