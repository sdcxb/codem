/**
 * Host 的文件读写与检索（G-7 剩余工具）。
 *
 * 与 `bash-run.ts` 同一纪律：**纯函数、可单测**；写操作必须经过 `approve()`（审批在 runtime 侧发），
 * 路径只能是工作区内的相对路径。检索本身不发审批 —— 只有**共享桌面工作区**下命中敏感路径时，
 * 调用方（`tools.ts`）才会先问一次（见 `sensitive-paths.ts`），本次检索不负责判定。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ApproveFn {
  (req: { tool: string; summary: string; details?: Record<string, unknown> }): Promise<{
    allowed: boolean;
    note?: string;
  }>;
}

export function resolveWorkspacePath(root: string, rel: string): string {
  const base = resolve(root);
  const p = String(rel ?? "").trim();
  if (!p) throw new Error("path 不能为空");
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) throw new Error("只接受相对工作区的路径");
  const abs = resolve(base, p);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error("路径逃出工作区");
  return abs;
}

export interface WriteResult {
  path: string;
  bytes: number;
  isError: boolean;
  output: string;
}

export async function writeWorkspaceFile(opts: {
  root: string;
  path: string;
  content: string;
  approve: ApproveFn;
}): Promise<WriteResult> {
  const abs = resolveWorkspacePath(opts.root, opts.path);
  const bytes = Buffer.byteLength(opts.content, "utf8");
  const decision = await opts.approve({
    tool: "write",
    summary: `写入文件 ${opts.path}（${bytes} 字节，覆盖）`,
    details: { path: opts.path, bytes },
  });
  if (!decision.allowed) {
    return {
      path: opts.path,
      bytes,
      isError: true,
      output: `未写入（用户拒绝${decision.note ? `：${decision.note}` : ""}）`,
    };
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, opts.content, "utf8");
  return { path: opts.path, bytes, isError: false, output: `已写入 ${opts.path}（${bytes} 字节）` };
}

export interface EditResult {
  path: string;
  replaced: number;
  isError: boolean;
  output: string;
}

export async function editWorkspaceFile(opts: {
  root: string;
  path: string;
  oldText: string;
  newText: string;
  approve: ApproveFn;
}): Promise<EditResult> {
  const abs = resolveWorkspacePath(opts.root, opts.path);
  const before = await readFile(abs, "utf8");
  if (!opts.oldText) return { path: opts.path, replaced: 0, isError: true, output: "old_string 不能为空" };
  const parts = before.split(opts.oldText);
  const count = parts.length - 1;
  if (count === 0) return { path: opts.path, replaced: 0, isError: true, output: "找不到要替换的文本（old_string 未命中）" };
  if (count > 1) {
    return { path: opts.path, replaced: count, isError: true, output: `old_string 命中 ${count} 次，必须唯一；请提供更长的上下文` };
  }
  const decision = await opts.approve({
    tool: "edit",
    summary: `编辑文件 ${opts.path}（替换 1 处，${opts.oldText.length}→${opts.newText.length} 字符）`,
    details: { path: opts.path, oldChars: opts.oldText.length, newChars: opts.newText.length },
  });
  if (!decision.allowed) {
    return { path: opts.path, replaced: 0, isError: true, output: `未修改（用户拒绝${decision.note ? `：${decision.note}` : ""}）` };
  }
  await writeFile(abs, parts.join(opts.newText), "utf8");
  return { path: opts.path, replaced: 1, isError: false, output: `已编辑 ${opts.path}（替换 1 处）` };
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** 检索时跳过的目录（`node_modules` 之类的依赖/构建产物 + 应用内部快照） */
export const GREP_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  ".next",
  ".codem-snapshots",
  ".codem-tool-results",
]);

/**
 * 遍历"可检索的普通文件"（目录顺序、跳过规则与 `grepWorkspace` 完全一致）。
 *
 * 抽出来的唯一理由：敏感读取审批需要**先只读列出**会被检索到的敏感文件名
 * （不读内容），再决定要不要弹一张卡。两处各写一遍 walk ⇒ 迟早一边漏掉某个 skip 目录。
 */
async function walkSearchableFiles(
  root: string,
  onFile: (rel: string, abs: string) => Promise<"continue" | "stop">,
): Promise<void> {
  const walk = async (dir: string): Promise<"continue" | "stop"> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (GREP_SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        const next = await walk(abs);
        if (next === "stop") return "stop";
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, abs).split(sep).join("/");
      const next = await onFile(rel, abs);
      if (next === "stop") return "stop";
    }
    return "continue";
  };
  await walk(resolve(root));
}

export interface GrepOptions {
  root: string;
  pattern: string;
  glob?: string;
  maxResults?: number;
  /**
   * 逐文件跳过（共享工作区下，未获批准的敏感文件用这里跳过）。
   *
   * 返回 true = 不读这个文件；跳过的数量会以 `skippedSensitive` 返回，
   * 调用方**必须**把它写进结果文案（否则"没有匹配"与"跳过了"就分不清了）。
   */
  skipPath?: (rel: string) => boolean;
}

/** 递归检索（跳过 .git / node_modules / 二进制），结果上限防炸内存 */
export async function grepWorkspace(opts: GrepOptions): Promise<{
  matches: GrepMatch[];
  truncated: boolean;
  skippedSensitive: number;
}> {
  const max = Math.max(1, Math.min(1000, opts.maxResults ?? 200));
  const re = new RegExp(opts.pattern, "i");
  const globRe = opts.glob ? new RegExp("^" + opts.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
  const matches: GrepMatch[] = [];
  let truncated = false;
  let skippedSensitive = 0;

  await walkSearchableFiles(opts.root, async (rel, abs) => {
    if (truncated) return "stop";
    if (globRe && !globRe.test(rel) && !globRe.test(rel.slice(rel.lastIndexOf("/") + 1))) {
      return "continue";
    }
    if (opts.skipPath?.(rel)) {
      skippedSensitive += 1;
      return "continue";
    }
    const info = await stat(abs).catch(() => null);
    if (!info || info.size > 2 * 1024 * 1024) return "continue";
    const text = await readFile(abs, "utf8").catch(() => null);
    if (text == null || text.includes("\u0000")) return "continue";
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 300) });
        if (matches.length >= max) {
          truncated = true;
          return "stop";
        }
      }
    }
    return "continue";
  });

  return { matches, truncated, skippedSensitive };
}

/**
 * 只读列出会被 `grepWorkspace` 看到的敏感文件（**不读内容**）。
 *
 * `limit` 是"最多列多少个"，不是"最多扫多少个文件"：超出时 `truncated=true`，
 * 审批卡应显示"≥N"。未列的敏感文件在批准后仍会被跳过（fail-closed）。
 */
export async function collectSensitiveGrepFiles(opts: {
  root: string;
  isSensitive: (rel: string) => boolean;
  limit?: number;
}): Promise<{ files: string[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
  const files: string[] = [];
  let truncated = false;
  await walkSearchableFiles(opts.root, async (rel) => {
    if (!opts.isSensitive(rel)) return "continue";
    if (files.length >= limit) {
      truncated = true;
      return "stop";
    }
    files.push(rel);
    return "continue";
  });
  return { files, truncated };
}

