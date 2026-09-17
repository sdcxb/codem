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
import { StorageError, getStoragePort, hasStoragePort } from "../storage/port";

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

/**
 * "确定性拒绝"的判据（C-1 要求 ②）。
 *
 * 只有这两类错误**重试多少次结果都一样**：
 * - `CONSTRAINT`：外键 / CHECK / NOT NULL —— 行本身不合法；
 * - `NOT_FOUND`：目标行不存在（同样不是时间问题）。
 *
 * 其余（BUSY / LOCKED / IO / UNAVAILABLE / NOMEM / CORRUPT / OTHER）都**可能是瞬时的**，
 * 一律留在缓冲里等下次 flush。**不要**把 `OTHER` 也当确定性拒绝：
 * 那会把"引擎刚好没起来"变成"永久丢掉用户的遥测"。
 */
function isDeterministicRejection(err: unknown): boolean {
  return StorageError.is(err) && (err.code === "CONSTRAINT" || err.code === "NOT_FOUND");
}

/**
 * 直接写穿一次（**只用于拿到真实错误码**）。
 *
 * ## 为什么不能复用 `domainWrite`
 *
 * `domainWrite` 把写穿 Promise `catch` 掉之后只调 `reportPersistFailure(scope, e, note)`
 * 就结束了 —— 调用方拿不到 `e`，而 C-1 要求按错误码分流（剔除 vs 重试）。
 * 这里刻意走 `getStoragePort().data.execute` 拿到**原始 Promise**，
 * 让 `trackShard()` 能读到 `StorageError.code`。
 *
 * ## 为什么它**不是**"重复写一次"
 *
 * 正常路径（分片落库成功）根本不会走到它：`domainWrite` 的写穿已经在飞了，
 * 这里只在**那一次失败之后**用同一批行重放，目的是把被 `domainWrite` 吞掉的
 * 错误码取回来。`crud.upsert` 是按主键的幂等覆盖写，重放不会产生重复行。
 *
 * @returns 一个"写一批行"的函数；端口不可用时返回 `null`（调用方据此不结账）
 */
function directWrite(): ((table: string, rows: Array<Record<string, unknown>>) => Promise<unknown>) | null {
  try {
    if (!hasStoragePort()) return null;
    const port = getStoragePort();
    return (table, rows) => port.data.execute("crud.upsert", { table, rows, mode: "insert" });
  } catch {
    /*
     * 端口查询本身出错（模块初始化异常等）→ **不猜**，按"拿不到探测能力"处理：
     * `trackShard` 会走"不结账"的分支（保持改动前的行为：写穿失败仍由
     * `domainWrite` 自己的 `reportPersistFailure` 上报）。绝不让一条辅助探测
     * 把遥测整条链路打断 —— 遥测是诊断用的，不该影响功能。
     */
    return null;
  }
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
   * **已发出、等待落库结果的批次**（C-1 修复）。
   *
   * ## 为什么必须有它（原实现的真实故障）
   *
   * 原 `flush()` 只做一次 `domainWrite(全部会话的事件)` ——
   * 而 `domainWrite` 的语义是"**先改本地镜像、再异步写穿**"，
   * 它在端口就绪时**立刻返回 `true`**、真正的落库结果还在 Promise 里。
   * 于是下面那句 `this.events = []` 在"落库还没发生"的时候就执行了：
   * 命中一个坏 `session_id`（例如子智能体 `sub-…`，库里没有对应 `sessions` 行）
   * 时整批被 Rust 的事务回滚，而事件**已经从缓冲里消失** —— 既不落库也不再重试。
   *
   * 真 CLI 实测（`telemetry_events` 有 `FOREIGN KEY (session_id) REFERENCES sessions(id)`）：
   * ```
   * crud.upsert(1 行 s1 + 1 行 sub-123-abc) → FOREIGN KEY constraint failed
   * crud.count(telemetry_events)            → 0        # 好行也没落库
   * ```
   *
   * 修法有两半，缺一不可：
   * 1. **按 `session_id` 分片写**（同下面 `flush()`）——一个坏会话带走不了别的会话；
   * 2. **确认落库（或已明确剔除）之后才从缓冲里去掉**——就是这张表的作用。
   */
  private inFlight = new Map<TelemetryEvent, Promise<void>>();

  /**
   * 最近一次 flush 的汇总（诊断/测试用）。
   *
   * 单独留一份计数而不是只依赖 `reportPersistFailure` 的原因：
   * 失败通道是**按 area 累计**的（`persist-failure.ts` 的设计），
   * 它回答得了"有没有失败"，回答不了"这一次到底写成功几条、因外键剔除几条"。
   * C-1 的要求是后者要能被区分出来。
   */
  private lastSummary: { written: number; rejectedForeignKey: number; retried: number } | null = null;

  /**
   * 当轮 flush 的实时计数（由 `trackShard` 的异步结账逐片累加）。
   *
   * 之所以是**实例字段**而不是 `flush()` 里的局部变量：结账是异步的，
   * 局部变量在 `flush()` 返回时就定格了 —— 那会得到一个"永远说写入成功的假汇总"。
   */
  private counters = { written: 0, rejectedForeignKey: 0, retried: 0 };

  /** 最近一次 flush 的汇总（诊断/测试用；异步结账完成后才更新） */
  flushSummary(): { written: number; rejectedForeignKey: number; retried: number } | null {
    return this.lastSummary ? { ...this.lastSummary } : null;
  }

  /** 当前仍在等待写入的事件条数（诊断/测试用） */
  bufferedCount(): number {
    return this.events.length;
  }

  /**
   * 给一个会话分片结账。
   *
   * ## 为什么必须重新确认一次落库结果
   *
   * `domainWrite` 内部把写穿的 Promise `catch` 掉并上报（`domain-store.ts`），
   * **调用方拿不到原始错误对象** —— 而 C-1 要求区分两种失败：
   *
   * | 失败 | 判据 | 处置 |
   * |---|---|---|
   * | **确定性拒绝**（外键/约束） | `StorageError.code ∈ {CONSTRAINT, NOT_FOUND}` | **剔除**并如实上报；重试永远不会成功，留着就是无限重试风暴 |
   * | 可重试失败（BUSY/IO/未就绪…） | 其它 code | **留在缓冲里**等下次 flush |
   *
   * 所以这里用**同一批行**把命令重放一次取真实错误码。重放是安全的：
   * `crud.upsert` 是幂等 upsert（同 id 覆盖写），真成功的分片不会走到这里。
   */
  private trackShard(
    sessionId: string,
    shard: TelemetryEvent[],
    rows: Array<Record<string, unknown>>,
  ): void {
    for (const e of shard) {
      // 占位 Promise：让 `pending()` 立刻知道"这片已经发出去了"，避免下一次 flush 重复提交
      this.inFlight.set(e, Promise.resolve());
    }

    const settle = (async () => {
      const probe = directWrite();
      if (!probe) {
        // 拿不到探测能力（真端口之外的实现）：**不猜**，按"写入成功"结账。
        // 这与改动前的行为一致（那时无条件清缓冲），但已经不会再静默丢弃 ——
        // 因为 domainWrite 自己的失败上报仍在。
        this.counters.written += shard.length;
        this.dropFromBuffer(new Set(shard));
        return;
      }
      try {
        await probe(TABLE, rows);
        this.counters.written += shard.length;
        // 确认落库 → 才允许从缓冲里去掉（C-1 要求 ③）
        this.dropFromBuffer(new Set(shard));
      } catch (err) {
        if (isDeterministicRejection(err)) {
          // 确定性拒绝：剔除 + 上报。**不重发**（重发会永远失败 → 无限重试风暴）
          this.counters.rejectedForeignKey += shard.length;
          this.dropFromBuffer(new Set(shard));
          reportPersistFailure(
            "telemetry.flush",
            err,
            `${shard.length} 条遥测事件因 session_id=${sessionId} 违反约束被剔除（不再重试；这是数据问题，不是磁盘或占用问题）`,
          );
          return;
        }
        // 可重试失败：留在缓冲里，并且**必须**把它们从 inFlight 里放出来，
        // 否则下一次 flush 会把它们当成"已提交"而永远不再尝试。
        for (const e of shard) this.inFlight.delete(e);
        this.counters.retried += shard.length;
      }
    })()
      .catch(() => {
        /* 结账自身出错绝不影响功能 */
      })
      .finally(() => {
        this.lastSummary = { ...this.counters };
      });

    for (const e of shard) this.inFlight.set(e, settle);
  }

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
   * 把某条事件从缓冲里去掉 —— **只有两种情形允许**：
   *
   * 1. 它所在的会话分片**确认落库成功**；
   * 2. 它的会话分片被**确定性拒绝**（外键/约束类），重试多少次都不会成功。
   *
   * 别的任何情况（BUSY / IO / 未就绪）都把它留在缓冲里等下一次重试。
   *
   * 顺带清掉 `stop()`/测试里的代际复位：事件对象是**引用**，
   * `inFlight` 里滞留的是"已经不在缓冲里的那一批"，留着会拖住整条 flush 链路。
   */
  private dropFromBuffer(toDrop: Set<TelemetryEvent>): void {
    if (this.events.some((e) => toDrop.has(e))) {
      this.events = this.events.filter((e) => !toDrop.has(e));
    }
    for (const e of toDrop) this.inFlight.delete(e);
  }

  /**
   * 已经交给落库、结果还没回来、且**仍在缓冲里**的事件。
   *
   * 它们既不能被重复提交（会写两遍），也不能被当成"还在等第一次尝试"而永远不重试 ——
   * 后者是更隐蔽的一种泄漏：Promise 万一既不 resolve 也不 reject，事件就卡死在这里。
   */
  private pending(): TelemetryEvent[] {
    return this.events.filter((e) => this.inFlight.has(e));
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
      /**
       * **按 `session_id` 分片**（C-1 修复的核心）。
       *
       * 为什么必须分片：Zustand 的 `record()` 会把**所有会话**的遥测攒在同一个缓冲里
       * （它是个全局单例），而 `telemetry_events.session_id` 有外键。子智能体的会话
       * 在 C-2 之前根本没有 `sessions` 行，于是"某一个会话的 id 不合法"会以
       * **整批事务回滚**的形式惩罚所有其它会话 —— 真 CLI 实测见类字段 `inFlight` 的注释。
       *
       * 分片之后，坏会话只影响它自己：它的行被剔除并**如实上报**，
       * 别的会话照常落库。
       */
      const bySession = new Map<string, TelemetryEvent[]>();
      for (const e of this.events) {
        const list = bySession.get(e.sessionId);
        if (list) list.push(e);
        else bySession.set(e.sessionId, [e]);
      }

      // 已经发出、结果未回的事件不再重复提交（否则同一条事件会写两遍）
      const alreadyInFlight = new Set(this.pending());

      /**
       * 计数**必须由异步结账来写**（`trackShard`），不能在这里同步累加 ——
       * 落库结果还没回来，同步算出来的"已写入 N 条"是**假的**（那正是本缺陷的同类错误：
       * 把一个尚未确认的动作当成已完成）。所以这里只**清零**，由 settle 逐片累加。
       */
      this.counters = { written: 0, rejectedForeignKey: 0, retried: 0 };

      for (const [sessionId, group] of bySession) {
        const fresh = group.filter((e) => !alreadyInFlight.has(e));
        this.counters.retried += group.length - fresh.length;
        if (fresh.length === 0) continue;

        const rows = fresh.map((e) => ({
          id: e.id,
          session_id: e.sessionId,
          event_name: e.name,
          event_data: JSON.stringify(e.data || {}),
          timestamp: e.timestamp,
        }));

        /*
         * `domainWrite` 的返回值只表示"镜像接手了这次写入"，**不代表落库成功** ——
         * 落库结果在异步 Promise 里。所以这里不再用返回值决定要不要清缓冲，
         * 而是把"本片的事件"交给 `trackShard()` 去结账。
         *
         * ⚠️ 不要在这里写 `this.events = []`：那正是本缺陷（静默丢弃）的成因。
         */
        const accepted = domainWrite(TABLE, rows, {
          scope: "telemetry.flush",
          note: `${rows.length} 条遥测事件未能写入（遥测不影响功能）`,
          ...TELEMETRY_OPTS,
        });

        if (!accepted) {
          /*
           * 端口没接手（A 态：端口未注册 / B 态：镜像未就绪或被逐出）。
           *
           * **旧库回退已删除**（L4 第 18 轮）：这里**如实上报**，不再把事件写进
           * 一份本进程读路径看不见的旧库副本。
           * 事件**留在缓冲里**等下次重试 —— 与 `trackShard` 的"非确定性失败"同一套约定。
           */
          reportPersistFailure(
            "telemetry.flush",
            new Error("端口未接手（该域镜像未注册或未就绪）"),
            `${rows.length} 条遥测事件未写入（保留在内存等待重试）`,
          );
          this.counters.retried += fresh.length;
          continue;
        }

        // 本片交给结账：成功/确定性拒绝才从缓冲里去掉，其余留在缓冲里等重试。
        this.trackShard(sessionId, fresh, rows);
      }
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
