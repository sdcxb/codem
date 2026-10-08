/**
 * @deprecated R3-Audit: This seam provider is deprecated and unreferenced.
 * Use src/core/provider/fs-provider.ts instead.
 *
 * LocalFileSystemProvider — Default FileSystem Seam Provider
 *
 * S0-3: Implements the FileSystemSeam interface using the local file-api.
 * This is the "local" provider — a sandboxed/remote provider could be
 * swapped in by registering a different provider for the "filesystem" seam.
 */

import type { FileSystemSeam } from "./types";
import type { GlobSearchResult } from "../file-api";

export class LocalFileSystemProvider implements FileSystemSeam {
  readonly id = "local-fs";

  isAvailable(): boolean {
    return true;
  }

  async readFile(path: string, cwd?: string): Promise<string> {
    const { readFile } = await import("../file-api");
    // Resolve relative paths against cwd if provided
    const resolvedPath = (cwd && !path.startsWith("/") && !path.match(/^[A-Za-z]:/)) 
      ? `${cwd.replace(/[/\\]+$/, "")}/${path}` 
      : path;
    /**
     * ★ 第 185 波（复审 R1-4/I-2）：**把 `cwd` 当工作区交给读侧沙箱**。
     *
     * 本 provider 由 `initDefaultSeams()` 在启动时注册（`App.tsx:1843`），
     * 而 `FileSystemSeam.readFile(path, cwd)` 的 `cwd` 就是调用方的工作区。
     * 改前这里只拿它拼相对路径、**不传 options** ⇒ `file-api.ts:68`
     * 的 `if (!workspace) return;` 让读侧检查整条失效（同 `writeFile` 却是传的 ⇒ 一写一读两份行为）。
     */
    return readFile(resolvedPath, { workspace: cwd });
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

  async glob(
    pattern: string,
    cwd?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<GlobSearchResult> {
    const { globSearch } = await import("../file-api");
    // ★ 第 185 波（复审 R1-4/I-2）：`glob` 也是读 —— 同一个工作区口径。
    /**
     * ★ 第 186 波：**原样透传结构化结果**（不再把 `files` 拆出来当数组）。
     *
     * 拆出来就等于把 `truncated` / `depth_limited` / `hint` 三件事实丢在这一层 ——
     * 调用方会以为拿到的是全部（那正是改前"超限报错"想避免、却用错了手段的失真）。
     * 类型跟着 `file-api.globSearch` 一起变（`FileSystemSeam.glob` 同一形状）。
     */
    return globSearch(pattern, cwd, { workspace: cwd, limit: options?.limit, offset: options?.offset });
  }

  async grep(pattern: string, cwd?: string, glob?: string): Promise<Array<{ file: string; line: number; content: string }>> {
    const { grepSearch } = await import("../file-api");
    // ★ 第 185 波（复审 R1-4/I-2）：`grep` 同上（改前两者都不传 ⇒ 读侧检查整条失效）。
    const results = await grepSearch(pattern, cwd, glob, { workspace: cwd });
    return results.map(r => ({ file: r, line: 0, content: r }));
  }
}
