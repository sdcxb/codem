/**
 * Telemetry — 采集器和 OpenTelemetry 导出
 *
 * Design (对标 DeepSeek Harness telemetry):
 * - 采集 agentic loop 中的关键事件
 * - 存储到 SQLite telemetry_events 表
 * - 支持 OpenTelemetry 格式导出（预留接口）
 */

import { getDatabase, persistDatabase, isCompactionInProgress, isDatabaseFatal, noteDatabaseError } from "../storage/database";
import { reportPersistFailure } from "../storage/persist-failure";
import { domainDeleteWhere, domainReadMany, domainWrite } from "../storage/domain-store";

// ========== Types ==========

export interface TelemetryEvent {
  id: string;
  sessionId: string;
  name: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ========== Telemetry Collector ==========

const TABLE = "telemetry_events";

/**
 * `telemetry_events` 的镜像上限（P5 第 2 段）。
 *
 * 遥测是只增不改的日志，量级可能到十万条。全表进渲染进程内存不可接受，
 * 所以给一个**较小**的镜像上限：超过就放弃镜像、回退旧路径。
 * 代价是"仪表盘在超大遥测表上仍然依赖旧库" —— 这比把渲染进程压死要好，
 * 而且遥测的历史数据本来就不需要精确（它是诊断用的，不是用户数据）。
 */
const TELEMETRY_MIRROR_MAX = 5000;
const TELEMETRY_OPTS = { maxRows: TELEMETRY_MIRROR_MAX };

interface TelemetryRow {
  id: string;
  session_id: string;
  event_name: string;
  event_data: string | null;
  timestamp: number;
}

function wireToTelemetry(row: Record<string, unknown>): TelemetryRow {
  return {
    id: String(row.id ?? ""),
    session_id: String(row.session_id ?? ""),
    event_name: String(row.event_name ?? ""),
    event_data: (row.event_data as string) ?? null,
    timestamp: Number(row.timestamp ?? 0),
  };
}

function telemetryToEvent(row: TelemetryRow): TelemetryEvent {
  let data: Record<string, unknown> | undefined;
  if (row.event_data) {
    try {
      data = JSON.parse(row.event_data) as Record<string, unknown>;
    } catch {
      data = undefined;
    }
  }
  return { id: row.id, sessionId: row.session_id, name: row.event_name, data, timestamp: row.timestamp };
}

/** 读整个遥测镜像；未接手时返回 undefined（调用方回退旧库） */
function telemetryRows(): TelemetryRow[] | undefined {
  return domainReadMany(TABLE, wireToTelemetry, undefined, TELEMETRY_OPTS);
}

/** 计数类聚合在**同一份数据**上算（旧实现是一串 COUNT/DISTINCT/GROUP BY） */
function groupBy<T, K extends string | number>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

class TelemetryCollector {
  private events: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private batchSize = 50;
  private flushIntervalMs = 5_000;
  /** 第 90 波：致命 DB 错误只上报一次 */
  private reportedFatal = false;

  /**
   * Record a telemetry event.
   */
  record(sessionId: string, name: string, data?: Record<string, unknown>): void {
    const event: TelemetryEvent = {
      id: `tel-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      sessionId,
      name,
      data,
      timestamp: Date.now(),
    };
    this.events.push(event);

    if (this.events.length >= this.batchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Flush all pending events to SQLite.
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.events.length === 0) return;

    /**
     * 第 90 波（用户现场）：数据库崩掉后（`RuntimeError: memory access out of bounds`），
     * 这里会**无限重排定时器** —— 日志里同一条 flush 失败刷了十几遍、还带着层层嵌套的
     * `setTimeout` 调用栈，事件却永远写不进去。
     * 现在：致命状态**不再重排**（事件留在内存、一次性上报给用户），普通失败才继续重试。
     */
    if (isDatabaseFatal()) {
      if (!this.reportedFatal) {
        this.reportedFatal = true;
        console.warn(`[Telemetry] 数据库已不可用，停止重试（${this.events.length} 条遥测事件保留在内存中）`);
        reportPersistFailure(
          "telemetry.flush",
          new Error("数据库模块已崩溃"),
          `${this.events.length} 条遥测事件未能写入（遥测不影响功能）`,
        );
      }
      return;
    }

    // Defense-in-depth: skip while compaction is mutating the DB.
    // Interleaving db.run with compaction's synchronous commit block corrupts
    // sql.js state ("bad parameter or other API misuse" / wasm traps).
    // Same guard as store.saveMessages — telemetry flush runs on a 5s timer
    // and can otherwise land inside a compaction window.
    if (isCompactionInProgress()) {
      // Keep events buffered; the next timer tick will retry.
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
      }
      return;
    }

    try {
      // P5 第 2 段：优先走端口（一次批量写 = 一次事务，比 N 条 db.run 更省往返）。
      const rustRows = this.events.map((e) => ({
        id: e.id,
        session_id: e.sessionId,
        event_name: e.name,
        event_data: JSON.stringify(e.data || {}),
        timestamp: e.timestamp,
      }));
      if (domainWrite(TABLE, rustRows, {
        scope: "telemetry.flush",
        note: `${this.events.length} 条遥测事件未能写入（遥测不影响功能）`,
        ...TELEMETRY_OPTS,
      })) {
        // 写穿是异步的：本地镜像已更新，若写穿失败会走上报通道（不会静默丢）
        this.events = [];
        return;
      }
      const db = getDatabase();
      for (const event of this.events) {
        db.run(
          "INSERT INTO telemetry_events (id, session_id, event_name, event_data, timestamp) VALUES (?, ?, ?, ?, ?)",
          [event.id, event.sessionId, event.name, JSON.stringify(event.data || {}), event.timestamp],
        );
      }
      persistDatabase();
      // 成功才清空 — 失败时保留 events 供下次重试（防静默丢失遥测）。
      this.events = [];
    } catch (err) {
      // 第 90 波：致命错误不再无限重试（见上方说明）；普通错误保留事件并有限重试
      if (noteDatabaseError(err)) {
        if (!this.reportedFatal) {
          this.reportedFatal = true;
          reportPersistFailure("telemetry.flush", err, `${this.events.length} 条遥测事件未能写入（遥测不影响功能）`);
        }
        return;
      }
      console.warn("[Telemetry] Flush failed, keeping events for retry:", err);
      // 保留 events；安排一次重试（限制频率避免热循环）
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
      }
    }
  }

  /**
   * Query events for a session.
   */
  query(sessionId: string, name?: string, limit?: number): TelemetryEvent[] {
    const rust = telemetryRows();
    if (rust) {
      return rust
        .filter((r) => r.session_id === sessionId && (!name || r.event_name === name))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit ?? undefined)
        .map(telemetryToEvent);
    }
    const db = getDatabase();
    const nameClause = name ? `AND event_name = ?` : "";
    const limitClause = limit ? `LIMIT ${limit}` : "";
    const params = name ? [sessionId, name] : [sessionId];

    const result = db.exec(
      `SELECT id, session_id, event_name, event_data, timestamp FROM telemetry_events WHERE session_id = ? ${nameClause} ORDER BY timestamp DESC ${limitClause}`,
      params,
    );

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      name: row[2] as string,
      data: row[3] ? JSON.parse(row[3] as string) : undefined,
      timestamp: row[4] as number,
    }));
  }

  /**
   * 清空全部遥测事件（仪表盘的"清空"按钮）。
   *
   * P5 第 2 段：这段逻辑原来写在 `PerformanceDashboard.tsx` 里 ——
   * **UI 组件直接 `getDatabase()` + `db.run("DELETE FROM telemetry_events")`**。
   * 那是 D 类（存储边界）违例：组件不该知道表名，而且切到 Rust 之后
   * 那个 DELETE 打的是旧库，仪表盘会"看起来清空了、刷新又回来"。
   * 现在收进采集器，走域端口（按 id 逐个删，线协议 where 不支持整表删除）。
   *
   * @returns 删除的行数；`null` 表示端口未接手（由调用方回退旧路径）
   */
  clearAll(): number | null {
    const rows = telemetryRows();
    if (!rows) return null;
    const removed = domainDeleteWhere(
      TABLE,
      () => true, // 全清（旧实现就是无条件 DELETE FROM telemetry_events）
      "id",
      { scope: "telemetry.clearAll", note: "遥测事件未清空", ...TELEMETRY_OPTS },
    );
    return removed;
  }

  /**
   * Export events in OpenTelemetry format (placeholder).
   */
  exportOTel(sessionId: string): string {
    const events = this.query(sessionId);
    const otelSpans = events.map(e => ({
      traceId: e.sessionId,
      spanId: e.id,
      name: e.name,
      startTimeUnixNano: e.timestamp * 1_000_000,
      attributes: e.data || {},
    }));
    return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: otelSpans }] }] }, null, 2);
  }

  // ========== P3-30: Performance Dashboard Aggregations ==========

  /**
   * 获取全局统计摘要 — 事件总数、按类型分组计数
   */
  getOverviewStats(): {
    totalEvents: number;
    totalSessions: number;
    eventsByType: Array<{ name: string; count: number }>;
    recentEventRate: number; // events per minute in last 5 min
  } {
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;

    const rust = telemetryRows();
    if (rust) {
      const byType = groupBy(rust, (r) => r.event_name);
      const eventsByType = [...byType.entries()]
        .map(([name, list]) => ({ name, count: list.length }))
        // 旧 SQL：GROUP BY event_name ORDER BY cnt DESC
        .sort((a, b) => b.count - a.count);
      const recentCount = rust.filter((r) => r.timestamp > fiveMinAgo).length;
      return {
        totalEvents: rust.length,
        totalSessions: new Set(rust.map((r) => r.session_id)).size,
        eventsByType,
        recentEventRate: Math.round((recentCount / 5) * 10) / 10,
      };
    }

    const db = getDatabase();

    let totalEvents = 0;
    let totalSessions = 0;
    let eventsByType: Array<{ name: string; count: number }> = [];
    let recentCount = 0;

    try {
      const r1 = db.exec("SELECT COUNT(*) as cnt FROM telemetry_events");
      if (r1.length > 0) totalEvents = r1[0].values[0][0] as number;

      const r2 = db.exec("SELECT COUNT(DISTINCT session_id) as cnt FROM telemetry_events");
      if (r2.length > 0) totalSessions = r2[0].values[0][0] as number;

      const r3 = db.exec("SELECT event_name, COUNT(*) as cnt FROM telemetry_events GROUP BY event_name ORDER BY cnt DESC");
      if (r3.length > 0) {
        eventsByType = r3[0].values.map((row: any[]) => ({ name: row[0] as string, count: row[1] as number }));
      }

      const r4 = db.exec("SELECT COUNT(*) as cnt FROM telemetry_events WHERE timestamp > ?", [fiveMinAgo]);
      if (r4.length > 0) recentCount = r4[0].values[0][0] as number;
    } catch (err) {
      console.warn("[Telemetry] getOverviewStats failed:", err);
    }

    return {
      totalEvents,
      totalSessions,
      eventsByType,
      recentEventRate: Math.round((recentCount / 5) * 10) / 10,
    };
  }

  /**
   * 获取会话级别性能统计 — 每个 session 的事件数、时延等
   */
  getSessionStats(limit = 20): Array<{
    sessionId: string;
    eventCount: number;
    firstEventAt: number;
    lastEventAt: number;
    duration: number; // ms
  }> {
    const rust = telemetryRows();
    if (rust) {
      const bySession = groupBy(rust, (r) => r.session_id);
      return [...bySession.entries()]
        .map(([sessionId, list]) => {
          const first = Math.min(...list.map((r) => r.timestamp));
          const last = Math.max(...list.map((r) => r.timestamp));
          return { sessionId, eventCount: list.length, firstEventAt: first, lastEventAt: last, duration: last - first };
        })
        // 旧 SQL：GROUP BY session_id ORDER BY last_ts DESC LIMIT n
        .sort((a, b) => b.lastEventAt - a.lastEventAt)
        .slice(0, limit);
    }
    const db = getDatabase();
    try {
      const result = db.exec(`
        SELECT session_id, COUNT(*) as cnt, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
        FROM telemetry_events
        GROUP BY session_id
        ORDER BY last_ts DESC
        LIMIT ${limit}
      `);
      if (result.length === 0) return [];
      return result[0].values.map((row: any[]) => ({
        sessionId: row[0] as string,
        eventCount: row[1] as number,
        firstEventAt: row[2] as number,
        lastEventAt: row[3] as number,
        duration: (row[3] as number) - (row[2] as number),
      }));
    } catch (err) {
      console.warn("[Telemetry] getSessionStats failed:", err);
      return [];
    }
  }

  /**
   * 获取时间序列 — 按时间桶聚合事件计数，用于绘制趋势图
   */
  getTimeSeries(bucketMs = 60_000, sinceMsAgo = 30 * 60 * 1000): Array<{
    timestamp: number;
    count: number;
  }> {
    const now = Date.now();
    const since = now - sinceMsAgo;
    const buckets: Array<{ timestamp: number; count: number }> = [];
    const bucketCount = Math.ceil(sinceMsAgo / bucketMs);

    const rust = telemetryRows();
    if (rust) {
      for (let i = 0; i < bucketCount; i++) {
        const bucketStart = since + i * bucketMs;
        const bucketEnd = bucketStart + bucketMs;
        const count = rust.filter((r) => r.timestamp >= bucketStart && r.timestamp < bucketEnd).length;
        buckets.push({ timestamp: bucketStart, count });
      }
      return buckets;
    }

    const db = getDatabase();
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = since + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      try {
        const r = db.exec(
          "SELECT COUNT(*) as cnt FROM telemetry_events WHERE timestamp >= ? AND timestamp < ?",
          [bucketStart, bucketEnd],
        );
        const count = r.length > 0 ? (r[0].values[0][0] as number) : 0;
        buckets.push({ timestamp: bucketStart, count });
      } catch {
        buckets.push({ timestamp: bucketStart, count: 0 });
      }
    }

    return buckets;
  }

  /**
   * 获取按事件类型的时延统计（如果 data 中有 duration_ms 字段）
   */
  getLatencyStats(): Array<{
    eventName: string;
    count: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
  }> {
    const rust = telemetryRows();
    if (rust) {
      // 旧 SQL：WHERE event_data LIKE '%"duration_ms"%' ORDER BY timestamp DESC LIMIT 10000
      const withDuration = rust
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10000)
        .filter((r) => (r.event_data ?? "").includes('"duration_ms"'));
      const groups: Record<string, number[]> = {};
      for (const row of withDuration) {
        const parsed = telemetryToEvent(row).data;
        const d = parsed?.duration_ms;
        if (typeof d === "number") {
          (groups[row.event_name] ??= []).push(d);
        }
      }
      return Object.entries(groups)
        .map(([eventName, durations]) => {
          const sorted = durations.sort((a, b) => a - b);
          const sum = sorted.reduce((a, b) => a + b, 0);
          const count = sorted.length;
          return {
            eventName,
            count,
            avgMs: Math.round(sum / count),
            minMs: sorted[0],
            maxMs: sorted[count - 1],
            p50Ms: sorted[Math.floor(count * 0.5)] || sorted[0],
            p95Ms: sorted[Math.floor(count * 0.95)] || sorted[count - 1],
          };
        })
        .sort((a, b) => b.count - a.count);
    }

    const db = getDatabase();
    try {
      // Fetch events that have duration_ms in their data
      const result = db.exec(`
        SELECT event_name, event_data FROM telemetry_events
        WHERE event_data LIKE '%"duration_ms"%'
        ORDER BY timestamp DESC
        LIMIT 10000
      `);
      if (result.length === 0) return [];

      // Group by event_name and compute stats
      const groups: Record<string, number[]> = {};
      for (const row of result[0].values as any[]) {
        const eventName = row[0] as string;
        const data = JSON.parse(row[1] as string);
        if (typeof data.duration_ms === "number") {
          if (!groups[eventName]) groups[eventName] = [];
          groups[eventName].push(data.duration_ms);
        }
      }

      return Object.entries(groups).map(([eventName, durations]) => {
        const sorted = durations.sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const count = sorted.length;
        return {
          eventName,
          count,
          avgMs: Math.round(sum / count),
          minMs: sorted[0],
          maxMs: sorted[count - 1],
          p50Ms: sorted[Math.floor(count * 0.5)] || sorted[0],
          p95Ms: sorted[Math.floor(count * 0.95)] || sorted[count - 1],
        };
      }).sort((a, b) => b.count - a.count);
    } catch (err) {
      console.warn("[Telemetry] getLatencyStats failed:", err);
      return [];
    }
  }
}

// ========== Singleton ==========

let collector: TelemetryCollector | null = null;

export function getTelemetry(): TelemetryCollector {
  if (!collector) {
    collector = new TelemetryCollector();
  }
  return collector;
}
