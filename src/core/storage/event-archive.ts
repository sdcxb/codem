/**
 * 事件保留（2026-10-29）：把过期的高频事件**先归档到文件、再从索引删除**。
 *
 * 为什么不是直接 `events.prune_older_than`：那条命令除 `session_meta` 外**全删**，
 * 而 `compaction` / `tool_call` / `tool_result` 是不可重建的（快照压缩会丢配对与时间上下文）。
 * 引擎新增的 `events.archive_before` 只删 `keep_types` 之外的类型，并把被删行返回；
 * 本模块负责把返回行写成 JSONL，再让下一次维护继续。
 *
 * 默认策略（可由设置覆盖）：90 天；保留 `session_meta` / `compaction` / `tool_call` /
 * `tool_result`；每次维护最多处理 100 个会话 × 每会话 2000 条，避免启动被拖住。
 *
 * 失败语义：归档写盘失败时**如实上报**（这批行已经从索引删除，文本事件仍可从会话 JSONL
 * 重建，但归档文件缺失）；不静默吞。
 */
import path from "node:path";
import { appendFile } from "../file-api";
import { getSettingJSON, setSettingJSON } from "./settings";
import { getStoragePort, hasStoragePort } from "./port";
import { resolveDataRoot } from "./data-root";
import { localDateString } from "../time/local-time";

const EVENT_RETENTION_SETTING = "codem-event-retention";
const EVENT_ARCHIVE_LAST_RUN = "codem-event-archive-last-run";

/** 语义事件：不归档、不删除（删了无法从消息重建） */
export const DEFAULT_EVENT_KEEP_TYPES = [
  "session_meta",
  "compaction",
  "tool_call",
  "tool_result",
] as const;

interface EventRetentionConfig {
  enabled: boolean;
  days: number;
  keepTypes: string[];
}

export interface EventArchiveResult {
  sessions: number;
  archived: number;
  skipped?: string;
}

/** 归档目录按**本地日**分桶（与 UI 的「今天」同口径） */

function readEventRetentionConfig(): EventRetentionConfig {
  const raw = getSettingJSON<Partial<EventRetentionConfig>>(EVENT_RETENTION_SETTING, {});
  const days = Number(raw.days ?? 90);
  const keepTypes = Array.isArray(raw.keepTypes) && raw.keepTypes.length > 0
    ? raw.keepTypes.map(String)
    : [...DEFAULT_EVENT_KEEP_TYPES];
  return {
    enabled: raw.enabled !== false,
    days: Number.isFinite(days) && days > 0 ? days : 90,
    keepTypes,
  };
}

/** 写入保留策略（设置面板/维护首次落地都用这一处；与 `readEventRetentionConfig` 成对） */
function setEventRetentionConfig(partial: Partial<EventRetentionConfig>): EventRetentionConfig {
  const next = { ...readEventRetentionConfig(), ...partial };
  setSettingJSON(EVENT_RETENTION_SETTING, next);
  return next;
}

function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

/**
 * 归档并删除一个会话中早于 `beforeTs` 的高频事件。
 * 返回实际归档行数（0 = 没有可归档的）。
 */
export async function archiveSessionEventsBefore(
  sessionId: string,
  beforeTs: number,
  opts: { keepTypes?: string[]; limit?: number; maxBatches?: number } = {},
): Promise<number> {
  if (!hasStoragePort()) return 0;
  const port = getStoragePort();
  if (!port.data.command) return 0; // 测试双/旧端口没有结构化命令：不做（不是失败）
  const keepTypes = opts.keepTypes ?? [...DEFAULT_EVENT_KEEP_TYPES];
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const maxBatches = Math.max(opts.maxBatches ?? 4, 1);

  let archived = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const res = await port.data.command<{ removed?: number; rows?: Array<Record<string, unknown>> }>(
      "events.archive_before",
      {
        session_id: sessionId,
        before_ts: beforeTs,
        keep_types: keepTypes,
        limit,
      },
    );
    const rows = Array.isArray(res?.rows) ? res.rows : [];
    if (!res?.removed || rows.length === 0) break;

    try {
      const base = (await resolveDataRoot()).root;
      const day = localDateString(new Date());
      const dir = path.join(base, "archives", "events", day);
      const file = path.join(dir, `${safeName(sessionId)}.jsonl`);
      // `append_file`（Rust）会递归创建父目录，这里不需要额外 mkdir
      const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await appendFile(file, lines);
    } catch (e) {
      /**
       * 行已经从索引删除；归档失败必须可见。不抛给维护（否则整轮维护失败），
       * 但调用方能在日志/返回值里看到缺口。
       */
      console.error(`[event-archive] 会话 ${sessionId} 的归档写盘失败（${rows.length} 行）:`, e);
      throw e;
    }
    archived += rows.length;
  }
  return archived;
}


/**
 * 维护入口：每 24h 最多跑一次，最多 100 个会话。
 * 调用方：`runDatabaseMaintenance` 末尾（后台、可失败）。
 */
export async function runEventArchiveMaintenance(
  now: number = Date.now(),
  opts: { maxSessions?: number; force?: boolean } = {},
): Promise<EventArchiveResult> {
  const cfg = readEventRetentionConfig();
  if (!cfg.enabled) return { sessions: 0, archived: 0, skipped: "disabled" };
  // 首次运行把默认策略落库（否则这个键永远“只读”，设置面板也无从改）
  if (getSettingJSON(EVENT_RETENTION_SETTING, null) === null) {
    setEventRetentionConfig(cfg);
  }
  if (!hasStoragePort()) return { sessions: 0, archived: 0, skipped: "no-port" };
  if (!getStoragePort().data.command) return { sessions: 0, archived: 0, skipped: "no-command" };

  if (!opts.force) {
    const last = Number(getSettingJSON<number>(EVENT_ARCHIVE_LAST_RUN, 0));
    if (Number.isFinite(last) && last > 0) {
      // 用日历日推进一天（不是 24h 常量）：与本地日窗口同口径
      const next = new Date(last);
      next.setDate(next.getDate() + 1);
      if (now < next.getTime()) return { sessions: 0, archived: 0, skipped: "throttled" };
    }
  }

  // 90 天也按日历日回退（DST 安全），不写裸日长
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - cfg.days);
  const beforeTs = cutoff.getTime();
  const maxSessions = Math.max(opts.maxSessions ?? 100, 1);
  let sessions = 0;
  let archived = 0;
  try {
    const page = await getStoragePort().data.query<{ id: string }>("crud.list", {
      table: "sessions",
      order_by: "last_message_at",
      limit: maxSessions,
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const row of items) {
      const sid = String(row.id ?? "");
      if (!sid) continue;
      sessions += 1;
      try {
        archived += await archiveSessionEventsBefore(sid, beforeTs, { keepTypes: cfg.keepTypes });
      } catch (e) {
        console.warn(`[event-archive] 会话 ${sid} 归档失败（继续下一个）:`, e);
      }
    }
    setSettingJSON(EVENT_ARCHIVE_LAST_RUN, now);
    return { sessions, archived };
  } catch (e) {
    setSettingJSON(EVENT_ARCHIVE_LAST_RUN, now);
    return { sessions, archived, skipped: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
