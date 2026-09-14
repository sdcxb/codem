/**
 * 会话的持久追加日志（JSONL）—— 对齐 DSH 的 `dsh-session-persistence-jsonl`（第 78 波）
 *
 * 为什么这是"治本"的最后一块：
 *   Codem 的本地 SQLite 是**整库常驻内存**、且 sql.js 只能**整库导出**。只要会话历史住在库里，
 *   库就会随对话无限增长 → 每次保存的导出/编码峰值随之增长 → 渲染进程 out of memory
 *   （用户报的那屏 `out of memory` 刷屏）。前几波把这条路上的风险压到最低（削峰、节流、原子写、
 *   WASM 引擎、溢出、事件快照压缩），但**"整库导出"这个动作本身还在**。
 *
 * DSH 的做法是：会话的权威存储是 **append-only JSONL**（增量追加，没有整库导出），
 * SQLite 只是**可重建的查询索引**。本模块把前半截搬过来：
 *   - 每条消息追加一行 JSON（`<appData>/sessions/<sessionId>.jsonl`），**追加即持久**，
 *     不需要导出任何"整库"；
 *   - 读取时按 id **后写者胜**（同一条消息被更新过就有多行，最后一行是当前状态）；
 *   - 损坏行只计数不致命（崩在写入中途最多丢最后一行，前面全部可读）。
 *
 * 有了它，SQLite 就可以被**有界裁剪**（见 `database.ts` 的 trimIndexedMessages）：
 * 只有当一条消息**确实已经在 JSONL 里**，才允许把它从索引里删掉 —— 这就是"索引可重建"的前提。
 */

import { getAppDataDir, appendFile, readFile, listDirectory, writeFile, deleteFile, renameFile } from "../file-api";
import type { Message } from "../../store";

/** 单行格式版本：将来改字段时按版本兼容读取 */
const LINE_VERSION = 1;

export interface JsonlMessageRecord {
  v: number;
  id: string;
  sessionId: string;
  role: string;
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  status?: string;
  /** 工具调用**必须一起持久化**：否则裁剪索引会把工具调用的真实内容丢掉 */
  toolCalls?: unknown;
  /** 生成文件等附加信息 */
  generatedFiles?: unknown;
  /**
   * 墓碑标记（第 78 波自查发现的问题）：删除必须**追加一条墓碑**，否则
   * "日志是权威、索引可重建"会立刻变成"删过的消息下次读取又回来了"。
   */
  deleted?: boolean;
}

let cachedDir: string | null = null;

async function sessionsDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const base = await getAppDataDir();
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  cachedDir = `${base}sessions${sep}`;
  return cachedDir;
}

/** 会话日志文件路径 */
export async function sessionLogPath(sessionId: string): Promise<string> {
  const dir = await sessionsDir();
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  const safe = (sessionId || "global").replace(/[^\w.-]+/g, "_");
  return `${dir}${safe}.jsonl`;
}

/** 测试用：清掉目录缓存 */
export function __resetJsonlCache(): void {
  cachedDir = null;
}

/**
 * 追加写是 fire-and-forget（写日志失败不能打断对话），但**耐久性检查必须看到最新日志**：
 * 否则裁剪索引时可能读到旧内容，导致"该裁的没裁"（无害）或时序上的误判。
 * `flushSessionLogWrites()` 用在需要确定性的地方（裁剪索引前、退出前）。
 */
const pendingAppends = new Set<Promise<void>>();

/** 等待所有在途的追加写落盘 */
export async function flushSessionLogWrites(): Promise<void> {
  if (pendingAppends.size === 0) return;
  await Promise.allSettled([...pendingAppends]);
}

/**
 * 追加一条消息（**追加即持久**，不做任何整库导出）。
 *
 * 失败只记日志、不抛：调用方（消息写入路径）已经有 SQLite 索引兜底，
 * 让"日志写不进去"把整个对话打断是本末倒置。
 */
export function appendSessionMessage(sessionId: string, message: Message): Promise<void> {
  const task = (async () => {
    try {
      const record: JsonlMessageRecord = {
        v: LINE_VERSION,
        id: message.id,
        sessionId,
        role: message.role,
        content: typeof message.content === "string" ? message.content : "",
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        timestamp: message.timestamp ?? Date.now(),
        ...(message.model ? { model: message.model } : {}),
        ...(message.status ? { status: message.status } : {}),
        ...((message as any).toolCalls ? { toolCalls: (message as any).toolCalls } : {}),
        ...((message as any).generatedFiles ? { generatedFiles: (message as any).generatedFiles } : {}),
      };
      // Rust 侧 append_file 会补一个换行 —— 正好是 JSONL 需要的行分隔
      await appendFile(await sessionLogPath(sessionId), JSON.stringify(record));
    } catch (e) {
      console.warn("[SessionJSONL] 追加消息失败（SQLite 索引仍在）:", e);
    }
  })();
  pendingAppends.add(task);
  void task.finally(() => pendingAppends.delete(task));
  return task;
}

/**
 * 读取会话日志：按 id 后写者胜，损坏行跳过并计数。
 *
 * @returns messages 与 skippedLines（损坏行数，用于诊断"日志是否被截断过"）
 */
export async function readSessionMessages(
  sessionId: string,
): Promise<{ messages: JsonlMessageRecord[]; skippedLines: number }> {
  const result: { messages: JsonlMessageRecord[]; skippedLines: number } = { messages: [], skippedLines: 0 };
  let raw: string;
  try {
    raw = await readFile(await sessionLogPath(sessionId));
  } catch {
    return result; // 还没有日志：正常（老会话尚未回填）
  }
  const byId = new Map<string, JsonlMessageRecord>();
  const tombstones = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonlMessageRecord;
      if (!parsed || typeof parsed.id !== "string") throw new Error("bad record");
      if (parsed.deleted) {
        // 墓碑：后写者胜的语义在"删除"上同样成立 —— 删除之后再写入就是重新出现
        tombstones.add(parsed.id);
        byId.delete(parsed.id);
        continue;
      }
      tombstones.delete(parsed.id);
      byId.set(parsed.id, parsed);
    } catch {
      result.skippedLines++;
    }
  }
  result.messages = [...byId.values()]
    .filter((m) => !tombstones.has(m.id))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return result;
}

/**
 * 追加一条墓碑（消息被删除时调用）。
 *
 * 为什么必须有：日志是权威存储、索引可重建 —— 如果删除只发生在索引里，
 * 那么下次从日志重建/合并时，删掉的消息会**复活**。墓碑让"删除"也变成一条可回放的记录。
 */
export async function appendMessageTombstone(sessionId: string, messageId: string): Promise<void> {
  try {
    const record: JsonlMessageRecord = {
      v: LINE_VERSION,
      id: messageId,
      sessionId,
      role: "tombstone",
      content: "",
      timestamp: Date.now(),
      deleted: true,
    };
    await appendFile(await sessionLogPath(sessionId), JSON.stringify(record));
  } catch (e) {
    console.warn("[SessionJSONL] 追加墓碑失败（索引已删除）:", e);
  }
}

/** 日志里已经持久化的消息 id 集合（裁剪索引前的**耐久性检查**用） */
export async function durableMessageIds(sessionId: string): Promise<Set<string>> {
  const { messages } = await readSessionMessages(sessionId);
  return new Set(messages.map((m) => m.id));
}

/**
 * 一次性回填：把 SQLite 里已有的消息导出成 JSONL（迁移用，幂等）。
 *
 * 幂等性靠"已有日志里的 id 集合"判断：只补缺失的消息，不重写整个文件
 * （重写会丢并发追加的窗口）。
 */
export async function backfillSessionLog(sessionId: string, messages: Message[]): Promise<number> {
  if (messages.length === 0) return 0;
  const existing = await durableMessageIds(sessionId);
  let appended = 0;
  for (const message of messages) {
    if (existing.has(message.id)) continue;
    await appendSessionMessage(sessionId, message);
    appended++;
  }
  if (appended > 0) {
    console.log(`[SessionJSONL] 会话 ${sessionId} 回填 ${appended} 条消息到追加日志`);
  }
  return appended;
}

/**
 * 列出已有日志文件的会话 id（维护时用来决定哪些会话需要回填/可裁剪）。
 */
export async function listSessionLogs(): Promise<string[]> {
  try {
    const dir = await sessionsDir();
    const entries = await listDirectory(dir);
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".jsonl"))
      .map((e) => e.name.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/** 会话被删除时同时清掉它的追加日志 */
export async function deleteSessionLog(sessionId: string): Promise<void> {
  try {
    await deleteFile(await sessionLogPath(sessionId));
  } catch {
    /* 文件可能本来就不存在 */
  }
}

/**
 * 追加日志压缩：把日志**重写**成"每个 id 只留最新一行"（第 79 波，收尾项）。
 *
 * 为什么需要：日志是 append-only，同一条消息被更新（流式回复、工具结果）就会多一行 ——
 * 长会话下日志会持续膨胀（本机实测单会话 2.8 MB）。压缩保留语义不变（后写者胜 + 墓碑），
 * 只是把被后续版本取代的行去掉。
 *
 * 安全要求：
 *   - **先写临时文件再改名**（原子替换）—— 压缩过程中崩掉不能把日志毁掉；
 *   - 压缩后的行数必须 ≥ 唯一 id 数，否则宁可放弃（宁可不省空间，也不能丢记录）；
 *   - 压缩前等齐在途追加写（`flushSessionLogWrites`）。
 *
 * @returns 是否真的压缩了，以及压缩前后的行数
 */
export async function compactSessionLog(
  sessionId: string,
): Promise<{ compacted: boolean; linesBefore: number; linesAfter: number }> {
  const out = { compacted: false, linesBefore: 0, linesAfter: 0 };
  try {
    await flushSessionLogWrites();
    const path = await sessionLogPath(sessionId);
    let raw: string;
    try {
      raw = await readFile(path);
    } catch {
      return out;
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    out.linesBefore = lines.length;
    if (lines.length < MIN_LOG_LINES_TO_COMPACT) return out;

    const lastById = new Map<string, string>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as JsonlMessageRecord;
        if (parsed && typeof parsed.id === "string") lastById.set(parsed.id, line);
      } catch {
        /* 坏行在压缩时被丢弃（它本来也读不出来） */
      }
    }
    out.linesAfter = lastById.size;
    // 安全性检查：压缩只应减少"被取代的旧行"，不能少于唯一 id 数
    if (out.linesAfter === 0 || out.linesAfter >= lines.length) return out;

    const tmp = `${path}.tmp`;
    await writeFile(tmp, [...lastById.values()].join("\n") + "\n");
    await renameFile(tmp, path);
    out.compacted = true;
    console.log(
      `[SessionJSONL] 会话 ${sessionId} 日志压缩：${out.linesBefore} 行 → ${out.linesAfter} 行（后写者胜语义不变）`,
    );
    return out;
  } catch (e) {
    console.warn("[SessionJSONL] 日志压缩失败（保留原文件）:", e);
    return out;
  }
}

/** 行数低于这个值不值得压缩 */
const MIN_LOG_LINES_TO_COMPACT = 200;

/** 测试用：直接写一份日志文件 */
export async function __writeSessionLogForTests(sessionId: string, lines: string[]): Promise<void> {
  await writeFile(await sessionLogPath(sessionId), lines.join("\n") + "\n");
}
