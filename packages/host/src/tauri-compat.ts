/**
 * **Tauri IPC 兼容层（Node 侧）** —— 让渲染侧那套 `file-api.ts`（21 个 `tauriInvoke`
 * 调用点、30+ 个文件读写函数）在 Host 里原样工作。
 *
 * ## 现状（2026-11）：`file-api` 已经改成显式 `FileTransport`（`setFileInvoker`），
 * 本文件的 invoker 现在有两个用途：① 作为 `FileTransport` 的实现注册给 file-api；
 * ② 给仍直接读 `window.__TAURI__` 的少数模块（`data-root` / `maintenance`）兜底。
 *
 * ## 为什么当初是"兼容层"而不是"改 file-api"
 *
 * `file-api.ts` 的传输收口在**一个函数**（`tauriInvoke`）里，但它直接读
 * `window.__TAURI__.core.invoke`。要让它可移植有两条路：
 *
 * 1. **改产品代码**：把 `tauriInvoke` 抽成可注入的 `FileTransport`（阶段 1 要做的**正解**）；
 * 2. **在宿主侧提供同名全局对象**（本文件）：不改任何产品代码，就能在 Node 里跑通
 *    权威日志、附件外置、快照等全部文件路径。
 *
 * Spike 选 2，因为它的价值是**先证明"这条链在 Node 里没有别的隐藏依赖"**；
 * 如果先改产品代码再验证，一旦还有别的坑，就分不清是"迁移没做完"还是"架构不成立"。
 * ADR-0001 把 1 列为阶段 1 的第一批改动（判据：本文件删除后 Spike 仍然通过）。
 *
 * ## 边界（安全）
 *
 * 兼容层只暴露**显式白名单**命令；未实现的命令一律抛错（不静默成功）。
 * 路径不做沙箱判断 —— 沙箱判断在 `file-api.ts` 里已经有一层，Host 的工具层还有一层。
 */

import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TauriCompatOptions {
  dataHome: string;
  dbPath: string;
  workspaceRoot: string;
}

interface InvokeArgs {
  path?: string;
  content?: string;
  oldPath?: string;
  newPath?: string;
  offset?: number;
  maxBytes?: number;
  encoding?: string;
}

const DEFAULT_WINDOW_BYTES = 256 * 1024;

/** 行对齐分窗读（与 Rust `read_text_window` 的契约一致） */
async function readTextWindow(path: string, offset: number, maxBytes: number) {
  const info = await stat(path);
  const size = info.size;
  const cap = Math.min(Math.max(maxBytes || DEFAULT_WINDOW_BYTES, 64 * 1024), 8 * 1024 * 1024);
  const handle = await open(path, "r");
  try {
    let windowBytes = cap;
    for (;;) {
      const length = Math.min(windowBytes, Math.max(0, size - offset));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const chunk = buffer.subarray(0, bytesRead);
      const atEof = offset + bytesRead >= size;
      if (atEof) {
        return {
          text: chunk.toString("utf8"),
          nextOffset: offset + bytesRead,
          eof: true,
          size,
        };
      }
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        return {
          text: chunk.subarray(0, lastNewline + 1).toString("utf8"),
          nextOffset: offset + lastNewline + 1,
          eof: false,
          size,
        };
      }
      if (windowBytes >= 8 * 1024 * 1024) {
        // 单行超过 8 MB：真实 JSONL 不会出现；照实返回并推进，避免调用方死循环。
        return { text: chunk.toString("utf8"), nextOffset: offset + bytesRead, eof: false, size };
      }
      windowBytes = Math.min(windowBytes * 2, 8 * 1024 * 1024);
    }
  } finally {
    await handle.close();
  }
}

export function createNodeFileInvoker(opts: TauriCompatOptions) {
  return async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const a = (args ?? {}) as InvokeArgs;
    switch (command) {
      case "storage_info":
        return { path: opts.dbPath, standard: false, reason: "codem-host（显式数据根）" };
      case "get_app_data_dir":
        return opts.dataHome;
      case "get_default_cwd":
        return opts.workspaceRoot;
      case "check_path_in_workspace":
        return true;
      case "read_file":
        return readFile(String(a.path), "utf8");
      case "write_file": {
        const target = String(a.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, String(a.content ?? ""), "utf8");
        return null;
      }
      case "append_file": {
        // Rust 侧 append_file 会补一个换行 —— JSONL 依赖它做行分隔，必须一致
        await appendFile(String(a.path), `${String(a.content ?? "")}\n`, "utf8");
        return null;
      }
      case "read_text_window":
        return readTextWindow(String(a.path), Number(a.offset ?? 0), Number(a.maxBytes ?? 0));
      case "path_exists":
        return existsSync(String(a.path));
      case "make_directory":
      case "create_directory":
        await mkdir(String(a.path), { recursive: true });
        return null;
      case "list_directory": {
        const entries = await readdir(String(a.path), { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          path: join(String(a.path), e.name),
          isDirectory: e.isDirectory(),
          size: 0,
        }));
      }
      case "delete_file":
        await rm(String(a.path), { force: true });
        return null;
      case "delete_directory":
      case "delete_directory_permanent":
        await rm(String(a.path), { recursive: true, force: true });
        return null;
      case "rename_file":
        await rename(String(a.oldPath), String(a.newPath));
        return null;
      case "file_version": {
        try {
          const info = await stat(String(a.path));
          return `${info.mtimeMs}:${info.size}`;
        } catch {
          return null;
        }
      }
      case "kill_session_processes":
        return false;
      default:
        throw new Error(
          `codem-host 未实现的 Tauri 命令：${command}` +
            (command.startsWith("secret_") ? "（Host 侧凭据存储是阶段 1 的迁移项）" : ""),
        );
    }
  };
}

/**
 * 安装兼容层。**必须在任何 `src/core` 的存储代码被调用之前执行**
 * （`file-api` / `data-root` 都是"调用时读全局"，所以模块导入顺序不影响）。
 */
export function installTauriCompat(opts: TauriCompatOptions): void {
  const invoke = createNodeFileInvoker(opts);
  const g = globalThis as unknown as {
    window?: Record<string, unknown>;
    __TAURI__?: unknown;
  };
  const bridge = { core: { invoke } };
  g.window = g.window ?? {};
  (g.window as Record<string, unknown>).__TAURI__ = bridge;
  // `data-root.ts` 读的是 `globalThis.__TAURI__`（不是 window 上那个）
  g.__TAURI__ = bridge;
}
