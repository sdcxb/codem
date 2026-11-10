/**
 * 上下文检查点的运行时索引（`context_epochs` 表）。
 *
 * 权威仍是 JSONL marker 的 `metadata.contextEpoch`；这张表只从时间线投影而来，
 * 用于按会话快速列出检查点（完整历史面板的“检查点索引”与后续审计）。
 * 读路径不依赖它（同步模型视图仍走 messages.metadata），所以表丢了不影响正确性。
 */
import { getStoragePort, hasStoragePort } from "./port";
import { normalizeEpochKind, normalizeSegmentSeq } from "../context/context-view";
import type { Message } from "../../store";

export interface ContextEpochRow {
  id: string;
  session_id: string;
  seq: number;
  cutoff_message_id: string;
  removed_count: number;
  kept_count: number;
  trigger_kind: string | null;
  /** `compact` | `switch`（D3）；旧行由投影补 `compact` */
  kind: string;
  /** 第几段（D1）；旧行补 1 */
  segment_seq: number;
  /**
   * switch 的 handoff 摘要（JSON 文本，可空；25 P0-0）。
   *
   * 形状由 `buildHandoffJson` 定义：
   * `{ v:1, ref, segmentSeq, summary, truncated, originalChars }`。
   * 旧行没有这一列/这一格 ⇒ `null`（不是空串），读侧必须容错。
   */
  handoff_json: string | null;
  created_at: number;
}

/**
 * handoff_json 的硬上限（8 KB；25 P0-0 要求「有上限，超限截断并标注」）。
 *
 * 用**字符数**而不是字节：与仓库其它文本预算（notes / marker）同一套口径；
 * 真正的落库列是 TEXT，不会因为多字节中文在 SQLite 里被二次截断。
 */
const HANDOFF_JSON_MAX_CHARS = 8 * 1024;

interface EpochMeta {
  epochId?: unknown;
  seq?: unknown;
  cutoffMessageId?: unknown;
  removedCount?: unknown;
  keptCount?: unknown;
  trigger?: unknown;
  createdAt?: unknown;
  kind?: unknown;
  segmentSeq?: unknown;
}

/**
 * 把 switch marker 的正文压成**有界、可解析**的 handoff_json。
 *
 * 为什么要有这一层（而不是直接把 marker 正文塞进列里）：
 * 1. 列名是 json，读侧要能 `JSON.parse`；正文里可能有引号/换行，必须先序列化；
 * 2. handoff 正文来自会话内容，没有上限就会让派生索引第 **二次**放大（marker 已存
 *    一份、索引再存一份）；8 KB 是本仓 notes/marker 同一量级的硬预算；
 * 3. 截断必须**自描述**：`truncated=true` + `originalChars` 让审计知道「这里不是全文」，
 *    不许静默截断后假装完整。
 *
 * 注意：`summary` 是 handoff 正文，不是语义摘要；真正的语义 handoff 仍等小模型灰度。
 * 截断按字符做，且用序列化后的长度回算（转义会放大长度），保证最终 JSON ≤ 8 KB。
 *
 * 写入时机（为什么不在 `performSegmentSwitch` 里同步写库）：
 * `context_epochs` 是**派生索引**，switch 的权威副本是 marker 自身；本函数在
 * `syncContextEpochs` 投影时被调用（真机：打开完整历史/审计；判据：显式投影）。
 * 换段函数保持同步、无 await（并发安全的前提），不为一张可重建的索引引入 IPC 等待。
 */
function buildHandoffJson(epochId: string, content: unknown, segmentSeq: number): string {
  const text = typeof content === "string" ? content : "";
  const originalChars = text.length;
  /* 先按最坏开销预留（truncated=true 时字段最长），再按序列化后的真实长度收缩 */
  let keep = Math.min(
    originalChars,
    Math.max(0, HANDOFF_JSON_MAX_CHARS - JSON.stringify({
      v: 1, ref: epochId, segmentSeq, summary: "", truncated: true, originalChars,
    }).length),
  );
  for (;;) {
    const json = JSON.stringify({
      v: 1,
      ref: epochId,
      segmentSeq,
      summary: text.slice(0, keep),
      truncated: keep < originalChars,
      originalChars,
    });
    if (json.length <= HANDOFF_JSON_MAX_CHARS || keep === 0) return json;
    /* 转义放大时按超出比例收缩；至少减 1，避免浮点回绕死循环 */
    keep = Math.max(0, Math.min(keep - 1, Math.floor((keep * HANDOFF_JSON_MAX_CHARS) / json.length) - 16));
  }
}

/** 从完整时间线里抽出 marker 的 epoch（旧 marker 没有 metadata 的自然跳过） */
export function epochRowsFromTimeline(sessionId: string, timeline: Message[]): ContextEpochRow[] {
  const rows: ContextEpochRow[] = [];
  for (const m of timeline) {
    const metadata = (m as unknown as { metadata?: unknown }).metadata;
    const obj = typeof metadata === "string"
      ? (() => { try { return JSON.parse(metadata) as Record<string, unknown>; } catch { return null; } })()
      : (metadata as Record<string, unknown> | undefined);
    const epoch = obj?.contextEpoch as EpochMeta | undefined;
    if (!epoch || typeof epoch.epochId !== "string" || typeof epoch.cutoffMessageId !== "string") continue;
    /* 与读侧同一份归一：只有显式 switch 才算 switch，段号非法值归 1 */
    const kind = normalizeEpochKind(epoch.kind);
    const segmentSeq = normalizeSegmentSeq(epoch.segmentSeq);
    rows.push({
      id: epoch.epochId,
      session_id: sessionId,
      seq: Math.max(0, Math.floor(Number(epoch.seq) || 0)),
      cutoff_message_id: epoch.cutoffMessageId,
      removed_count: Math.max(0, Math.floor(Number(epoch.removedCount) || 0)),
      kept_count: Math.max(0, Math.floor(Number(epoch.keptCount) || 0)),
      trigger_kind: typeof epoch.trigger === "string" ? epoch.trigger : null,
      kind,
      segment_seq: segmentSeq,
      /*
       * 只有 switch 写 handoff_json：compact 的 marker 正文是压缩摘要，不是段间交接；
       * 旧 compact 行保持 NULL（契约「可空」），读侧不需要用空串占位。
       * 正文从**权威 marker 自身**取（handoffRef 指向它自己的 id），不做二次存储决策。
       */
      handoff_json: kind === "switch"
        ? buildHandoffJson(epoch.epochId, (m as unknown as { content?: unknown }).content, segmentSeq)
        : null,
      created_at: Math.max(0, Math.floor(Number(epoch.createdAt) || 0)),
    });
  }
  return rows;
}

async function command<T>(name: string, params: Record<string, unknown>): Promise<T | null> {
  if (!hasStoragePort()) return null;
  const data = getStoragePort().data;
  const fn = data.command;
  if (!fn) return null;
  try {
    return await fn.call(data, name, params) as T;
  } catch (e) {
    // 索引表是派生数据：写失败不能影响主链路；保留日志供排查。
    console.warn(`[ContextEpochs] ${name} 失败（派生索引，不影响模型视图）:`, e);
    return null;
  }
}

/** 把时间线里的 epoch 投影进表（幂等） */
export async function syncContextEpochs(sessionId: string, timeline: Message[]): Promise<number> {
  const rows = epochRowsFromTimeline(sessionId, timeline);
  let written = 0;
  for (const row of rows) {
    const res = await command<{ written?: number }>("context_epochs.upsert", row as unknown as Record<string, unknown>);
    if (res) written += Number(res.written ?? 0);
  }
  return written;
}

export async function listContextEpochs(sessionId: string): Promise<ContextEpochRow[]> {
  const res = await command<{ items?: ContextEpochRow[] }>("context_epochs.list", { session_id: sessionId, limit: 100 });
  if (!Array.isArray(res?.items)) return [];
  /*
   * 旧库兼容：读取时把缺失/非字符串的 handoff_json 归一成 null（契约「可空」）。
   * 为什么不在 SQL 里 `COALESCE`：Rust 读路径同样要能返回「这一格确实没有」，
   * 而派生索引的读侧归一放在适配层一处，面板/审计不必各判一次 `undefined`。
   */
  return res.items.map((row) => ({
    ...row,
    handoff_json: typeof row.handoff_json === "string" ? row.handoff_json : null,
  }));
}
