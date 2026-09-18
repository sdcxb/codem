/**
 * 超大工具结果的溢出保存（spill）—— 对齐 DSH 的做法（第 76 波）
 *
 * 参考实现（本机 DSH 安装目录）：
 *   - `dsh-spill-policy`：结果超过 `maxInlineBytes` 时，把**全文**存到会话私有文件，
 *     模型侧只保留**有界 head/tail 预览 + 一行说明**（保留了多少、省略了多少、全文在哪）。
 *   - `dsh-output-retention`：`TextRetainer` 按 **字节** 计预算，head/tail 两端切分，
 *     并做 UTF-8 边界修剪（`trimTrailingPartialUtf8` / `trimLeadingContinuationUtf8`）——
 *     按字符切会在多字节边界上切出半个字符，落库/回放都会出现替换字符。
 *   - `dsh-spill-local`：溢出文件是**会话私有**目录下的文件，靠路径当定位符（locator）。
 *
 * 为什么 Codem 需要它（本波要治的本）：
 *   1. 本地 SQLite 是**整库常驻内存**（sql.js）且只能整库导出，`tool_calls.result` 这类
 *      "一次性大文本"会把库越撑越大 —— 大库意味着每次保存的 export/编码峰值越来越大；
 *   2. 单条工具结果动辄几百 KB 到几 MB（构建日志、整文件 dump），而对话里真正需要长期留在
 *      上下文里的只是**头部和尾部**；全文留在磁盘上随时可读。
 *
 * 约定（与 DSH 的措辞一致，便于对照排查）：
 *   - 预算按 **字节**（UTF-8），默认 64 KB 以上才溢出（只拦真正的大块，不打扰常规结果）；
 *   - 预览 = 前半 + 后半，省略部分给出明确说明与全文路径；
 *   - 溢出文件写盘是**原子**的（先写 .tmp 再改名，与 DSH `dsh-atomic-write` 同策略）。
 */

import { writeFile, renameFile, listDirectory, deleteFile } from "../file-api";

/** 默认内联上限（字节）：超过就溢出到文件。只拦真正的大块。 */
export const DEFAULT_MAX_INLINE_BYTES = 64 * 1024;

/** 预览预算：默认给 8 KB（前后各一半）——足够模型判断"这是什么、结尾发生了什么"。 */
export const DEFAULT_PREVIEW_BYTES = 8 * 1024;

const encoder = new TextEncoder();

/** UTF-8 字节长度（不依赖 Buffer，浏览器/WebView 一致） */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** 从字节偏移处安全地向前/向后对齐到 UTF-8 边界（避免切出半个多字节字符） */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * 按字节预算取 head/tail 预览，并在 UTF-8 边界上修剪。
 * 返回预览文本与"实际省略的字节数"，便于生成诚实的说明行。
 */
export function headTailPreview(
  text: string,
  budgetBytes: number,
): { preview: string; omittedBytes: number; keptBytes: number } {
  const bytes = encoder.encode(text);
  const total = bytes.length;
  if (total <= budgetBytes) {
    return { preview: text, omittedBytes: 0, keptBytes: total };
  }
  const headBytes = Math.ceil(budgetBytes / 2);
  const tailBytes = Math.floor(budgetBytes / 2);

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let headEnd = Math.min(headBytes, total);
  while (headEnd > 0 && isContinuationByte(bytes[headEnd])) headEnd--; // 头部：不要切断后续字节
  let tailStart = Math.max(headEnd, total - tailBytes);
  while (tailStart < total && isContinuationByte(bytes[tailStart])) tailStart++; // 尾部：从字符起点开始

  const head = decoder.decode(bytes.subarray(0, headEnd));
  const tail = decoder.decode(bytes.subarray(tailStart, total));
  const keptBytes = headEnd + (total - tailStart);
  const omittedBytes = Math.max(0, total - keptBytes);
  return { preview: `${head}\n\n……（中间省略）……\n\n${tail}`, omittedBytes, keptBytes };
}

/** 溢出说明行（对齐 DSH `describeOmitted` + locator 的措辞） */
export function spillNotice(omittedBytes: number, locator: string): string {
  return `（已省略 ${omittedBytes} 字节；完整结果保存在：${locator}）`;
}

/** 会话私有的溢出目录 */
function spillDir(baseDir: string, sessionId: string): string {
  const sep = baseDir.includes("/") && !baseDir.includes("\\") ? "/" : "\\";
  return `${baseDir}spill${sep}${sessionId || "global"}`;
}

export interface SpillResult {
  /** 应当写入数据库/送入上下文的文本（预览 + 说明，或原文） */
  text: string;
  /** 是否发生了溢出 */
  spilled: boolean;
  /** 全文落盘路径（溢出时） */
  locator?: string;
  /** 全文原始字节数 */
  totalBytes: number;
  /** 被省略的字节数 */
  omittedBytes: number;
}

/**
 * 按上限决定是否溢出，并在需要时把**全文**写入会话私有文件。
 *
 * 注意：只有确实超过 `maxInlineBytes` 才会去做任何 I/O —— 常规工具结果零开销。
 */
export async function retainToolResult(
  text: string,
  opts: {
    sessionId?: string;
    toolName?: string;
    callId?: string;
    maxInlineBytes?: number;
    previewBytes?: number;
  } = {},
): Promise<SpillResult> {
  const maxInline = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const previewBudget = opts.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const totalBytes = utf8Length(text);
  if (totalBytes <= maxInline) {
    return { text, spilled: false, totalBytes, omittedBytes: 0 };
  }

  const { preview, omittedBytes } = headTailPreview(text, previewBudget);
  // 第 62 轮：溢出文件与库同属一份数据集 —— 目录跟着引擎实际使用的库走（见 data-root.ts）
  const baseDir = (await (await import("./data-root")).resolveDataRoot()).root;
  const sep = baseDir.includes("/") && !baseDir.includes("\\") ? "/" : "\\";
  const rawCallId = String(opts.callId ?? Date.now());
  const safeName = `${(opts.toolName || "tool").replace(/[^\w.-]+/g, "_")}-${rawCallId.replace(/[^\w.-]+/g, "_")}-${Date.now()}.txt`;
  const locator = `${spillDir(baseDir, opts.sessionId || "")}${sep}${safeName}`;

  // 原子写：先 .tmp 再改名 —— 半截文件会把"全文在这里"变成一句假话
  await writeFile(`${locator}.tmp`, text);
  await renameFile(`${locator}.tmp`, locator);

  return {
    text: `${preview}\n\n${spillNotice(omittedBytes, locator)}`,
    spilled: true,
    locator,
    totalBytes,
    omittedBytes,
  };
}

/** 默认保留天数。溢出文件是"可再读的副本"，过期即可清理。 */
export const DEFAULT_SPILL_KEEP_DAYS = 14;

/**
 * 清理过期的溢出文件。
 *
 * 为什么必须有（本波自查发现的问题）：溢出把大文本从数据库搬到磁盘，**磁盘同样会涨** ——
 * 只写不删等于把"库无限增长"换成"溢出处无限增长"。DSH 那边溢出文件是**会话私有**的
 * （`dsh-spill-local`），随会话生命周期回收；Codem 这边按时间回收是等价的最小实现：
 * 保留最近 N 天，超期删除，并顺带清掉写了一半的 `.tmp`。
 *
 * 时间戳写在**文件名**里（`<tool>-<callId>-<epochMs>.txt`）：`list_directory` 不回传修改时间，
 * 靠文件名判断既不需要新增 IPC，也不受"拷贝/移动后 mtime 变化"的影响。
 *
 * @returns 删除的文件数与释放的字节数
 */
export async function pruneSpillFiles(
  opts: { keepDays?: number; now?: number } = {},
): Promise<{ deletedFiles: number }> {
  const keepDays = opts.keepDays ?? DEFAULT_SPILL_KEEP_DAYS;
  const now = opts.now ?? Date.now();
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const result = { deletedFiles: 0 };

  // 第 62 轮：溢出文件与库同属一份数据集 —— 目录跟着引擎实际使用的库走（见 data-root.ts）
  const baseDir = (await (await import("./data-root")).resolveDataRoot()).root;
  let sessions: Awaited<ReturnType<typeof listDirectory>> = [];
  try {
    sessions = await listDirectory(`${baseDir}spill`);
  } catch {
    return result; // 还没有溢出目录 —— 正常
  }

  for (const entry of sessions) {
    if (!entry.isDirectory) continue;
    let files: Awaited<ReturnType<typeof listDirectory>> = [];
    try {
      files = await listDirectory(entry.path);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.isDirectory) continue;
      if (file.name.endsWith(".tmp")) {
        // 写盘中间态：改名成功就不会留下；还留着说明当时崩了，清掉
        try { await deleteFile(file.path); result.deletedFiles++; } catch { /* 跳过 */ }
        continue;
      }
      const match = /-(\d{10,})\.txt$/.exec(file.name);
      const writtenAt = match ? Number(match[1]) : 0;
      if (writtenAt > 0 && writtenAt >= cutoff) continue; // 还在保留期内
      if (writtenAt === 0) continue; // 认不出来历的文件不碰（可能是用户自己放的）
      try {
        await deleteFile(file.path);
        result.deletedFiles++;
      } catch {
        /* 单个文件删不掉就跳过 */
      }
    }
  }
  if (result.deletedFiles > 0) {
    console.log(`[Spill] 清理过期溢出文件 ${result.deletedFiles} 个（保留最近 ${keepDays} 天）`);
  }
  return result;
}
