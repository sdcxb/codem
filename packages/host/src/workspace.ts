/**
 * 工作区只读访问（`workspace.list` / `workspace.read`）。
 *
 * 为什么从 `runtime.ts` 抽成纯函数：Host 到底在用哪个工作区，**唯一可观察证据**就是这两个
 * 接口；把根目录作为显式参数，判据才能直接对着临时项目断言（`--workspace <桌面项目>` ⇒
 * `workspace.list` 真的列出那个项目），而不必装配数据库、起整个 HostRuntime。
 *
 * 安全边界与工具层完全一致：所有路径先过 `resolveInsideRoot`（拒绝绝对路径、`..`、
 * 符号链接逃逸），手机端传入的任何路径都不能读到工作区之外。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { HostError } from "./errors";
import { resolveInsideRoot } from "./tools";

export interface WorkspaceEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFileText {
  path: string;
  size: number;
  truncated: boolean;
  text: string;
  encoding: "utf8" | "binary";
}

/** 列出工作区目录（只读；目录逃逸由 `resolveInsideRoot` 拒绝） */
export async function listWorkspaceDir(root: string, path = "."): Promise<WorkspaceListing> {
  const abs = await resolveInsideRoot(root, path || ".");
  const info = await stat(abs);
  if (!info.isDirectory()) throw new HostError("INVALID_PARAMS", `不是目录：${path}`);
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  for (const d of dirents.slice(0, 500)) {
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      entries.push({ name: d.name, type: "dir" });
    } else if (d.isFile()) {
      const s = await stat(join(abs, d.name)).catch(() => null);
      entries.push({ name: d.name, type: "file", ...(s ? { size: s.size } : {}) });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: path === "." ? "" : path.replace(/^\.\//, ""), entries };
}

/** 读工作区文件（只读预览；二进制只报 encoding=binary，不把字节塞进 JSON） */
export async function readWorkspaceFile(
  root: string,
  path: string,
  offset = 0,
  limit = 200_000,
): Promise<WorkspaceFileText> {
  const abs = await resolveInsideRoot(root, path);
  const info = await stat(abs);
  if (!info.isFile()) throw new HostError("INVALID_PARAMS", `不是普通文件：${path}`);
  const buf = await readFile(abs);
  if (buf.includes(0)) {
    return { path, size: info.size, truncated: false, text: "", encoding: "binary" };
  }
  const text = buf.toString("utf8");
  const slice = text.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
  return { path, size: info.size, truncated: slice.length < text.length, text: slice, encoding: "utf8" };
}
