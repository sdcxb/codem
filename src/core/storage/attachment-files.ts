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

import { writeFile, renameFile, readFile, listDirectory, deleteFile } from "../file-api";

/** 超过这个字节数的附件内容外置（UTF-16 字符串按字符数近似即可） */
export const DEFAULT_EXTERNALIZE_THRESHOLD = 64 * 1024;

/** 数据库里表示"内容在文件里"的标记前缀 */
export const FILE_CONTENT_PREFIX = "file:";

/** 判断某个 content 值是否指向外置文件 */
export function isExternalContent(content: string | null | undefined): boolean {
  return typeof content === "string" && content.startsWith(FILE_CONTENT_PREFIX);
}

/** 从标记里取出文件路径 */
function externalPathOf(content: string): string {
  return content.slice(FILE_CONTENT_PREFIX.length);
}

async function attachmentsDir(): Promise<string> {
  /**
   * 第 62 轮：附件正文外置的落点跟着**引擎实际使用的库目录**走（见 `data-root.ts`）。
   * 外置正文是消息正文的一部分（`file:` 标记指向它），索引与它必须同属一份数据集 ——
   * 否则把库拷到别处（便携模式）之后，消息索引指向的附件正文留在原机器上。
   */
  const { resolveDataRoot } = await import("./data-root");
  const base = (await resolveDataRoot()).root;
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
async function readExternalAttachment(path: string): Promise<string | undefined> {
  try {
    return await readFile(path);
  } catch (e) {
    console.warn(`[Attachment] 读取外置附件失败：${path}`, e);
    return undefined;
  }
}

/**
 * 按**附件 id** 在附件目录里找回外置文件（第 233 轮审计 · P0）。
 *
 * ## 为什么需要（索引可重建，但它不带附件）
 *
 * `attachments` 表是**可重建的投影**，而重建路径（`messages_rebuild_index`）
 * 只重放 messages / tool_calls，**不重放 attachments**；权威日志里也没有
 * `file:<路径>` 标记（外置是**异步队列**做的，日志行写下时附件还是内联形态）。
 *
 * 于是"重建之后"这三个事实同时成立：
 * - 正文文件还在 `<dataRoot>/attachments/` 里（`externalizeAttachmentContent` 的产物）；
 * - 索引里没有任何一行指向它；
 * - 日志里也没有指针。
 *
 * 结果就是附件**永久不可达**——文件在、名字在、没人知道它属于谁。
 * 但文件名本身就是线索：`<safeId>-<safeName>`（`externalizeAttachmentContent` 的规则，
 * `safeId` 就是附件 id）。所以按 id 前缀扫一次目录即可找回 —— 这条路径让
 * "重建后仍能读到附件"成为结构性质，不依赖任何新增的 DB 命令或日志格式变更。
 *
 * 成本：一次目录列举，**只在"索引里没有这一行"的未命中路径**上发生。
 */
export async function findExternalFileByAttachmentId(attachmentId: string): Promise<string | undefined> {
  const safeId = (attachmentId || "").replace(/[^\w.-]+/g, "_");
  if (!safeId) return undefined;
  let entries: Awaited<ReturnType<typeof listDirectory>> = [];
  try {
    entries = await listDirectory(await attachmentsDir());
  } catch {
    return undefined;
  }
  const prefix = `${safeId}-`;
  const hit = entries.find(
    (e) => !e.isDirectory && e.name.startsWith(prefix) && !e.name.endsWith(".tmp"),
  );
  return hit?.path;
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
function externalContentCacheSize(): number {
  return externalContentCache.size;
}

/**
 * 清理孤儿附件文件：文件存在、但数据库里已经没有对应标记的（附件被删除/会话被清理）。
 * 与 JSONL 日志、spill 文件遵循同一套"保留策略"原则：只写不删等于把增长换个地方。
 *
 * ## ★ 第 233 轮审计（P0）：**「零引用」不等于「全是孤儿」**
 *
 * 破坏性事实：库损坏 → 引擎从 JSONL 重建索引时**只重放 messages / tool_calls，
 * 不重放 attachments**（`repo.rs` 的 `messages_rebuild_index`）；而权威日志里
 * `attachmentsForLog` 又刻意**不写** `content`（只有元数据，`file:<路径>` 标记不进日志）。
 * 于是重建之后 `attachments` 表是空的，`attachments.externalized` 返回 `{items: []}`，
 * 上层据此判成「权威的空清单」⇒ `referenced = ∅` ⇒ 本函数把 `<dataRoot>/attachments/` 下
 * **每一个**外置正文（大文档/图片的唯一副本）删掉，且没有恢复路径。
 *
 * 判据：**调用方说「一条引用都没有」、而目录里确实有文件**时，这几乎必然是
 * 「标记清单不可信」，而不是「所有附件同时被删干净」。这种形态下拒绝删除
 * （`.tmp` 例外：它们是原子写盘的中间产物，永远可以清），并把原因交回调用方去如实上报。
 *
 * 代价：用户真的删光所有附件时，外置文件会留到下一次「有引用」的清理。
 * 这是有意的取舍 —— 多留几个文件，远好过把用户唯一的副本删掉。
 *
 * @returns 删除的文件数（被跳过时带原因）
 */
export async function pruneOrphanAttachmentFiles(
  referencedPaths: Set<string>,
): Promise<{ deletedFiles: number; skippedUnreferenced?: number; reason?: string }> {
  let deletedFiles = 0;
  let entries: Awaited<ReturnType<typeof listDirectory>> = [];
  try {
    entries = await listDirectory(await attachmentsDir());
  } catch {
    return { deletedFiles }; // 还没有附件目录
  }

  const tmpFiles: typeof entries = [];
  const candidates: typeof entries = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name.endsWith(".tmp")) tmpFiles.push(entry);
    else candidates.push(entry);
  }

  // `.tmp` 是原子写盘的中间产物：无论引用清单是否可信都可以清
  for (const entry of tmpFiles) {
    try { await deleteFile(entry.path); deletedFiles++; } catch { /* 跳过 */ }
  }

  if (candidates.length > 0 && referencedPaths.size === 0) {
    console.warn(
      `[Attachment] 引用清单为空但目录里有 ${candidates.length} 个文件 —— 拒绝按「孤儿」清理` +
        `（空清单更可能来自索引重建/迁移，而不是附件全被删）。已保留全部正文，避免不可逆的数据丢失。`,
    );
    return { deletedFiles, skippedUnreferenced: candidates.length, reason: "no-references" };
  }

  for (const entry of candidates) {
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
