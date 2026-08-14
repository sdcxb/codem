/**
 * LocalFileSystemProvider — Default FileSystem Seam Provider
 *
 * S0-3: Implements the FileSystemSeam interface using the local file-api.
 * This is the "local" provider — a sandboxed/remote provider could be
 * swapped in by registering a different provider for the "filesystem" seam.
 */

import type { FileSystemSeam } from "./types";

export class LocalFileSystemProvider implements FileSystemSeam {
  readonly id = "local-fs";

  isAvailable(): boolean {
    return true;
  }

  async readFile(path: string, _cwd?: string): Promise<string> {
    const { readFile } = await import("../file-api");
    return readFile(path);
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    const { writeFile } = await import("../file-api");
    return writeFile(path, content, { workspace: cwd });
  }

  async listDirectory(path: string): Promise<Array<{ name: string; isDir: boolean; size: number }>> {
    const { listDirectory } = await import("../file-api");
    const entries = await listDirectory(path);
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory, size: 0 }));
  }

  async deleteFile(path: string): Promise<void> {
    // Fallback: use Tauri invoke directly if available
    try {
      const { invoke } = (window as any).__TAURI__?.core || {};
      if (invoke) {
        await invoke("delete_file", { path });
      }
    } catch {
      // ignore
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { listDirectory } = await import("../file-api");
      const parent = path.split(/[\\/]/).slice(0, -1).join("/") || "/";
      const name = path.split(/[\\/]/).pop() || "";
      const entries = await listDirectory(parent);
      return entries.some(e => e.name === name);
    } catch {
      return false;
    }
  }

  async glob(pattern: string, cwd?: string): Promise<string[]> {
    const { globSearch } = await import("../file-api");
    return globSearch(pattern, cwd);
  }

  async grep(pattern: string, cwd?: string, glob?: string): Promise<Array<{ file: string; line: number; content: string }>> {
    const { grepSearch } = await import("../file-api");
    const results = await grepSearch(pattern, cwd, glob);
    return results.map(r => ({ file: r, line: 0, content: r }));
  }
}
