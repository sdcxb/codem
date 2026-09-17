/**
 * Telemetry — 采集器和 OpenTelemetry 导出
 *
 * Design (对标 DeepSeek Harness telemetry):
 * - 采集 agentic loop 中的关键事件
 * - 存储到 SQLite telemetry_events 表
 * - 支持 OpenTelemetry 格式导出（预留接口）
 */

import { isCompactionInProgress } from "../storage/compaction-state";
import { storageUnavailable } from "../storage/health";
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
 * 所以给一个**较小**的镜像上限：超过就放弃镜像（此时读取如实返回空结果，
 * L4 第 18 轮起不再回退旧库）。
 * 代价是"仪表盘在超大遥测表上会显示空" —— 这比把渲染进程压死要好，
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

/**
 * 读整个遥测镜像；未接手时返回 `undefined`。
 *
 * L4 第 18 轮起：`undefined` 不再意味着"回退旧库"（那条路已删除），
 * 而是"该域当前读不到" —— 调用方据此返回合理空结果或如实上报。
 */
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
     *
     * 第 18 轮：判据从 `isDatabaseFatal()`（旧引擎致命态，rust 下恒为 false）
     * 换成 `storageUnavailable()`（本进程没有可用存储 = 端口没注册）。
     */
    if (storageUnavailable()) {
      if (!this.reportedFatal) {
        this.reportedFatal = true;
        console.warn(`[Telemetry] 存储不可用，停止重试（${this.events.length} 条遥测事件保留在内存中）`);
        reportPersistFailure(
          "telemetry.flush",
          new Error("本进程没有可用存储（端口未注册）"),
          `${this.events.length} 条遥测事件未能写入（遥测不影响功能）`,
        );
      }
      return;
    }

    // Defense-in-depth: skip while compaction is mutating the message set.
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
      /*
       * **旧库回退已删除**（L4 第 18 轮）：端口没接手时**如实上报**，不再把事件写进
       * 一份本进程读路径看不见的旧库副本（旧库已从渲染进程移除，写它既读不回来、
       * 也算不上"保存成功"）。
       *
       * 这里**不清空 `this.events`** —— 与上面"成功才清空"的既有约定一致：
       * 遥测写不进去时保留在内存里等下次重试，而不是静默丢掉。
       */
      reportPersistFailure(
        "telemetry.flush",
        new Error("端口未接手（该域镜像未注册或未就绪）"),
        "遥测事件未写入（保留在内存等待重试）",
      );
      return;
    } catch (err) {
      // 第 90 波：致命错误不再无限重试（见上方说明）；普通错误保留事件并有限重试。
      // 第 18 轮：`noteDatabaseError` 那套"是否致命"分类随旧引擎删除 ——
      // 分类的用途（决定要不要一次性上报）现在由"端口是否可用"表达。
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
    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
    // （旧库已从渲染进程移除，读不到就是读不到）
    return [];
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
   * ## 第 18 轮：返回值契约改了（真机缺陷修正）
   *
   * 原来是 `number | null`，`null` 表示"端口未接手 → 调用方回退旧库"。
   * 而调用方（`PerformanceDashboard`）拿到 `null` 就去 `getDatabase()` ——
   * 在 rust 模式下那句**必抛** `Database not initialized`，于是"清空遥测"整个失败：
   * 失败被 catch 吞成一行 warn，而 `setShowClearConfirm(false)` 在抛点之后，
   * **确认弹窗根本不关**（界面卡住，用户以为点了没反应）。
   *
   * A 态（旧库回退）已删，所以只剩一种诚实表达：**返回真实删除行数，
   * 失败走 `reportPersistFailure` 如实上报**（`domainDeleteWhere` 内部已经做了）。
   * `0` 因此有两种含义（本来就没有 / 没删成），但"没删成"一定伴随上报，不会静默。
   */
  clearAll(): number {
    const rows = telemetryRows();
    if (!rows) {
      reportPersistFailure(
        "telemetry.clearAll",
        new Error("遥测域镜像未就绪"),
        "遥测事件未清空（本次没有清空任何行）",
      );
      return 0;
    }
    const removed = domainDeleteWhere(
      TABLE,
      () => true, // 全清（旧实现就是无条件 DELETE FROM telemetry_events）
      "id",
      { scope: "telemetry.clearAll", note: "遥测事件未清空", ...TELEMETRY_OPTS },
    );
    return removed ?? 0;
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

    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时如实返回"空统计"
    // （而不是去读一份已从渲染进程移除的旧库）
    return { totalEvents: 0, totalSessions: 0, eventsByType: [], recentEventRate: 0 };
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
    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
    return [];
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

    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
    return [];
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

    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
    return [];
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
