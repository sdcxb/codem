/**
 * @deprecated R3-Audit: This seam provider is deprecated.
 * Use src/core/provider/fs-provider.ts instead.
 *
 * LocalFileSystemProvider — Default FileSystem Seam Provider
 *
 * S0-3: Implements the FileSystemSeam interface using the local file-api.
 * This is the "local" provider — a sandboxed/remote provider could be
 * swapped in by registering a different provider for the "filesystem" seam.
 *
 * ## 本轮（SEAM-DEL）：`deleteFile` 的静默失败 —— 选了「接上」，不是「下线」
 *
 * 改前 `deleteFile` 的行为是「试着自己 invoke 一次、出错就当没发生」（`catch {}` 吞掉一切）：
 * 自己拼了**第二个** `invoke("delete_file")`（命令名的第二份定义），而且
 * **删不掉也不说** —— 调用方以为删了。这与刚修完的兄弟
 * `src/core/provider/fs-provider.ts` 的 `deleteFile` 是同一形态。
 *
 * 为什么不下线（grep 证据，见判据文件头）：`deleteFile` 的**消费者一个都没有**
 * （`readViaSeam`（`tools.ts:174`）只取 `readFile`；全仓 `getProvider("filesystem")` 的
 * 使用点只有 `readFile` / 接口实现检查）。但**既有通道是可用的**：
 * `file-api.deleteFile`（`file-api.ts:307`）就是同一个操作、且 `delete_file` 命令
 * 在 `lib.rs` 的 `invoke_handler` 里真实注册。所以"接上既有通道"既恢复了
 * `FileSystemSeam.deleteFile`（`types.ts:120`）承诺的能力，又让命令名只剩一处定义 ——
 * 比"抛未实现/删空壳"更好（后者会让一个可用的能力不可用）。
 *
 * 判据：`src/test/seam-local-fs-delete.test.ts`（SEAM-DEL-1..3、SEAM-EXISTS-1）。
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

  /**
   * 删除文件。
   *
   * ★ 本轮（SEAM-DEL）：**接上既有通道 + 失败如实冒泡**。
   *
   * 不再自己拼 `invoke("delete_file")`：命令名的唯一定义处是 `file-api.ts`，
   * 这里只做转发。**没有 `catch`** —— IPC 不可用 / 文件被占用 / 权限不足
   * 一律原样抛出（删不掉绝不当成删掉了）。
   */
  async deleteFile(path: string): Promise<void> {
    const { deleteFile } = await import("../file-api");
    await deleteFile(path);
  }

  /**
   * 路径是否存在。
   *
   * ★ 本轮（SEAM-DEL 同形态）：**父目录读不到 ≠ 文件不存在**。
   * 改前 `catch { return false }` 把「我读不了」说成「它不存在」（假否定）——
   * 与 `fs-provider.exists` 那一处、以及 `file-api.grepSearch` 反复踩过的同一个坑。
   * 现在读失败如实抛出，由调用方决定要不要当成不存在。
   */
  async exists(path: string): Promise<boolean> {
    const { listDirectory } = await import("../file-api");
    const parent = path.split(/[\\/]/).slice(0, -1).join("/") || "/";
    const name = path.split(/[\\/]/).pop() || "";
    const entries = await listDirectory(parent);
    return entries.some(e => e.name === name);
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
