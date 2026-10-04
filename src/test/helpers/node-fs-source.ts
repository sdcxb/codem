/**
 * 判据用的 {@link TestFileSource} 实现：**真实 Node fs**（第 114 波）。
 *
 * 为什么需要它：生产代码在装机版里走 Tauri IPC（`core/file-api.ts`），
 * 而 Node/Vitest 里没有那套 IPC ⇒ 判据必须自己提供一个文件访问实现 ✓。
 *
 * ⚠️ 这个文件在 `src/test/helpers/` 下 ⇒ **不在** FSG-1 门禁的扫描范围里
 * （门禁只扫 `src/core/llm/**` 的生产文件 ✓），所以这里用 `node:fs` 是**允许**的 ✓ ——
 * 它就是"判据侧的真 fs" ✓。
 *
 * 同时它也**解释了 114 波那个坑**为什么能藏那么久：判据跑在 Node 里，
 * `node:fs` 是真的 ⇒ 用 `node:fs` 的生产代码在判据里**一切正常** ✗，
 * 只有装机版才拿到桩（`readdirSync` 恒 `[]`）✗。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DirEntry, TestFileSource } from "../../core/llm/task-keyword-search";

export function nodeFsSource(): TestFileSource {
  return {
    async list(dir: string): Promise<DirEntry[]> {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        path: join(dir, e.name),
        isDirectory: e.isDirectory(),
      }));
    },
    async read(path: string, maxBytes?: number): Promise<string> {
      const text = readFileSync(path, "utf8");
      return maxBytes ? text.slice(0, maxBytes) : text;
    },
  };
}

/** 便捷：这个路径是不是目录（判据里偶尔要断言夹具结构） */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
