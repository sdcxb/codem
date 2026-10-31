/**
 * 上下文检查点的运行时索引（`context_epochs` 表）。
 *
 * 权威仍是 JSONL marker 的 `metadata.contextEpoch`；这张表只从时间线投影而来，
 * 用于按会话快速列出检查点（完整历史面板的“检查点索引”与后续审计）。
 * 读路径不依赖它（同步模型视图仍走 messages.metadata），所以表丢了不影响正确性。
 */
import { getStoragePort, hasStoragePort } from "./port";
import type { Message } from "../../store";

export interface ContextEpochRow {
  id: string;
  session_id: string;
  seq: number;
  cutoff_message_id: string;
  removed_count: number;
  kept_count: number;
  trigger_kind: string | null;
  created_at: number;
}

interface EpochMeta {
  epochId?: unknown;
  seq?: unknown;
  cutoffMessageId?: unknown;
  removedCount?: unknown;
  keptCount?: unknown;
  trigger?: unknown;
  createdAt?: unknown;
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
    rows.push({
      id: epoch.epochId,
      session_id: sessionId,
      seq: Math.max(0, Math.floor(Number(epoch.seq) || 0)),
      cutoff_message_id: epoch.cutoffMessageId,
      removed_count: Math.max(0, Math.floor(Number(epoch.removedCount) || 0)),
      kept_count: Math.max(0, Math.floor(Number(epoch.keptCount) || 0)),
      trigger_kind: typeof epoch.trigger === "string" ? epoch.trigger : null,
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
  return Array.isArray(res?.items) ? res.items : [];
}
