/**
 * Telemetry — 采集器和 OpenTelemetry 导出
 *
 * Design (对标 DeepSeek Harness telemetry):
 * - 采集 agentic loop 中的关键事件
 * - 存储到 SQLite telemetry_events 表
 * - 支持 OpenTelemetry 格式导出（预留接口）
 */

import { getDatabase, persistDatabase } from "../storage/database";

// ========== Types ==========

export interface TelemetryEvent {
  id: string;
  sessionId: string;
  name: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ========== Telemetry Collector ==========

class TelemetryCollector {
  private events: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private batchSize = 50;
  private flushIntervalMs = 5_000;

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

    try {
      const db = getDatabase();
      for (const event of this.events) {
        db.run(
          "INSERT INTO telemetry_events (id, session_id, event_name, event_data, timestamp) VALUES (?, ?, ?, ?, ?)",
          [event.id, event.sessionId, event.name, JSON.stringify(event.data || {}), event.timestamp],
        );
      }
      persistDatabase();
    } catch (err) {
      console.warn("[Telemetry] Flush failed:", err);
    }

    this.events = [];
  }

  /**
   * Query events for a session.
   */
  query(sessionId: string, name?: string, limit?: number): TelemetryEvent[] {
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
    const db = getDatabase();
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;

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
    const db = getDatabase();
    const now = Date.now();
    const since = now - sinceMsAgo;
    const buckets: Array<{ timestamp: number; count: number }> = [];
    const bucketCount = Math.ceil(sinceMsAgo / bucketMs);

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
