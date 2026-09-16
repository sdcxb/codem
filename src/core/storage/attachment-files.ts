/**
 * 附件内容外置（第 80 波，路线收尾项之一）
 *
 * 为什么必须做：`attachments.content` 把**文档全文**存在 SQLite 里（长文档几十 MB），
 * 而 Codem 的本地库是整库常驻内存、sql.js 只能**整库导出** —— 一条大附件就会把每次保存的
 * 内存峰值顶上去（与前几波治的是同一个根）。页面里已经有注释指出过这个坑
 * （`listAllAttachments` 曾因此把每行全文读进内存）。
 *
 * 设计（不引入 schema 变更、不改变既有行为）：
 *   - **小内容保持内联**（图片 data URL、短文本）—— 常见场景行为完全不变；
 *   - 大内容（默认 > 64 KB）写入 `<appData>/attachments/<附件id>-<安全文件名>`，
 *     数据库 `content` 列存**标记** `file:<绝对路径>`，`preview` 列保留开头若干字符供列表显示；
 *   - `getAttachmentContent()` 遇到标记时读文件返回 → **调用方无感**；
 *   - 写盘**原子**（先 `.tmp` 再 rename），失败则回退内联（宁可库大一点，也不能丢附件）。
 */

import { getAppDataDir, writeFile, renameFile, readFile, listDirectory, deleteFile } from "../file-api";

/** 超过这个字节数的附件内容外置（UTF-16 字符串按字符数近似即可） */
export const DEFAULT_EXTERNALIZE_THRESHOLD = 64 * 1024;

/** 数据库里表示"内容在文件里"的标记前缀 */
export const FILE_CONTENT_PREFIX = "file:";

/** 判断某个 content 值是否指向外置文件 */
export function isExternalContent(content: string | null | undefined): boolean {
  return typeof content === "string" && content.startsWith(FILE_CONTENT_PREFIX);
}

/** 从标记里取出文件路径 */
export function externalPathOf(content: string): string {
  return content.slice(FILE_CONTENT_PREFIX.length);
}

async function attachmentsDir(): Promise<string> {
  const base = await getAppDataDir();
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  return `${base}attachments${sep}`;
}

/**
 * 把附件内容写入外置文件。
 *
 * @returns 成功时返回 `file:<路径>` 标记与预览；失败抛错（调用方回退内联）
 */
export async function externalizeAttachmentContent(
  attachmentId: string,
  fileName: string,
  content: string,
): Promise<{ marker: string; preview: string }> {
  const dir = await attachmentsDir();
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  const safeId = (attachmentId || "att").replace(/[^\w.-]+/g, "_");
  const safeName = (fileName || "attachment").replace(/[^\w.-]+/g, "_").slice(-60);
  const path = `${dir}${safeId}-${safeName}`;

  await writeFile(`${path}.tmp`, content);
  await renameFile(`${path}.tmp`, path);

  return {
    marker: `${FILE_CONTENT_PREFIX}${path}`,
    preview: content.slice(0, 2000),
  };
}

/** 读取外置附件内容（标记 → 文件内容） */
export async function readExternalAttachment(path: string): Promise<string | undefined> {
  try {
    return await readFile(path);
  } catch (e) {
    console.warn(`[Attachment] 读取外置附件失败：${path}`, e);
    return undefined;
  }
}

/**
 * 外置内容的内存缓存（路径 → 内容），带**总字节预算 + LRU 逐出**（P6 第 3 段）。
 *
 * 为什么需要缓存：附件的读取路径（`loadAttachmentsForMessage` / `getAttachmentContent`）
 * 是**同步**的，而文件读取是异步 IPC。所以采用"预取 + 同步命中"：
 * 进入会话/启动维护时调 `hydrateAttachments()` 把外置内容读进这里，之后同步路径透明命中；
 * 未命中时返回 undefined 并**补一次异步读取**（下次读取即可命中），绝不让气泡渲染出 `file:` 标记。
 *
 * ## 为什么必须加上限（这一段补的）
 *
 * 原来是"读过就永不释放"的 `Map`：附件正文动辄几 MB（外置阈值是 64KB），
 * 用户翻过十个长文档附件，几十 MB 就**永久**留在渲染进程里 ——
 * 与 P6 第 2 段给消息镜像加预算治的是同一种病（驻留无界）。
 *
 * 上限取 32MB：真实文档附件基本都能装下（保持"同步命中"的既有体验），
 * 但堆不会再无界增长。超预算时按 LRU 逐出最久未用的**单条**；
 * 逐出后该路径的下一次读取会走"补一次异步预取"的既有路径（返回 undefined、下次命中），
 * 也就是**退化一次、不会读到错内容**。
 */
const EXTERNAL_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const externalContentCache = new Map<string, string>();
let externalCacheBytes = 0;
let externalCacheEvictions = 0;

/** 当前缓存占用（诊断/测试用，让"驻留有界"可断言） */
export function externalContentCacheStats(): { entries: number; bytes: number; evictions: number; budgetBytes: number } {
  return {
    entries: externalContentCache.size,
    bytes: externalCacheBytes,
    evictions: externalCacheEvictions,
    budgetBytes: EXTERNAL_CACHE_BUDGET_BYTES,
  };
}

/** 命中即"最新使用"（Map 迭代序 = 插入序，删了再插即移到末尾） */
function touchExternal(path: string, content: string): void {
  externalContentCache.delete(path);
  externalContentCache.set(path, content);
}

function putExternal(path: string, content: string): void {
  if (externalContentCache.has(path)) {
    // 覆盖：先把旧占用的字节扣掉，避免重复计数
    externalCacheBytes -= externalContentCache.get(path)!.length;
    externalContentCache.delete(path);
  }
  externalContentCache.set(path, content);
  externalCacheBytes += content.length;
  while (externalCacheBytes > EXTERNAL_CACHE_BUDGET_BYTES && externalContentCache.size > 1) {
    const oldest = externalContentCache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === path) break;
    const dropped = externalContentCache.get(oldest)!;
    externalContentCache.delete(oldest);
    externalCacheBytes -= dropped.length;
    externalCacheEvictions++;
  }
}

/** 同步取已缓存的外置内容 */
export function getCachedExternalContent(path: string): string | undefined {
  const hit = externalContentCache.get(path);
  if (hit !== undefined) touchExternal(path, hit);
  return hit;
}

/** 预热单个路径（未命中时调用；完成后写入缓存） */
export async function warmExternalContent(path: string): Promise<string | undefined> {
  const cached = externalContentCache.get(path);
  if (cached !== undefined) {
    touchExternal(path, cached);
    return cached;
  }
  const content = await readExternalAttachment(path);
  if (content !== undefined) putExternal(path, content);
  return content;
}

/** 测试/会话关闭时清理缓存 */
export function clearExternalContentCache(): void {
  externalContentCache.clear();
  externalCacheBytes = 0;
}

/**
 * 预热一个会话里所有外置附件（进入会话 / 启动维护时调用）。
 * 返回预热条数。
 */
export async function hydrateAttachmentsForSession(
  rows: Array<{ id: string; content: string | null }>,
): Promise<number> {
  let warmed = 0;
  for (const row of rows) {
    if (!row.content || !isExternalContent(row.content)) continue;
    const path = externalPathOf(row.content);
    if (externalContentCache.has(path)) continue;
    if ((await warmExternalContent(path)) !== undefined) warmed++;
  }
  return warmed;
}

/** 缓存大小（诊断） */
export function externalContentCacheSize(): number {
  return externalContentCache.size;
}

/**
 * 清理孤儿附件文件：文件存在、但数据库里已经没有对应标记的（附件被删除/会话被清理）。
 * 与 JSONL 日志、spill 文件遵循同一套"保留策略"原则：只写不删等于把增长换个地方。
 *
 * @returns 删除的文件数
 */
export async function pruneOrphanAttachmentFiles(
  referencedPaths: Set<string>,
): Promise<{ deletedFiles: number }> {
  let deletedFiles = 0;
  let entries: Awaited<ReturnType<typeof listDirectory>> = [];
  try {
    entries = await listDirectory(await attachmentsDir());
  } catch {
    return { deletedFiles }; // 还没有附件目录
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name.endsWith(".tmp")) {
      try { await deleteFile(entry.path); deletedFiles++; } catch { /* 跳过 */ }
      continue;
    }
    if (referencedPaths.has(entry.path)) continue;
    try {
      await deleteFile(entry.path);
      deletedFiles++;
    } catch {
      /* 单个删不掉就跳过 */
    }
  }
  if (deletedFiles > 0) console.log(`[Attachment] 清理孤儿附件文件 ${deletedFiles} 个`);
  return { deletedFiles };
}
