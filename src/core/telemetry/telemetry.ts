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

/** 一轮 flush 的汇总（诊断/测试用） */
interface RoundSummary {
  written: number;
  rejectedForeignKey: number;
  retried: number;
  /** 本轮**提交**的事件数（恒等式的右边，见 `flushSummary()`） */
  expected: number;
}

/**
 * 已结账轮次的保留上限。
 *
 * 只是诊断数据（"最近几次 flush 各自写了几条"），留一段就够；
 * 不设上限会在长跑进程里慢慢攒对象（每轮一个新对象，且永不被读）。
 */
const FLUSH_ROUND_HISTORY_MAX = 20;

/**
 * 一轮 flush 的**独立**计数载体（任务 Y-3）。
 *
 * ## 为什么是一个"每轮新建的对象"而不是实例字段
 *
 * 结账（`trackShard` 的 `settle`）是**异步**的：上一轮的结账可能在下一轮
 * `flush()` 之后才跑完。只要计数放在实例字段上并"每轮清零"，迟到的结账就会把
 * 自己那一轮的数字加进新一轮里，得到"2 条事件里 1 条被写、1 条待重试"这种
 * **自相矛盾**的汇总（实测：`after flush#2: {written:1, retried:1}` →
 * `after release: {written:2, retried:1}`）。
 *
 * 每轮一个对象之后，"谁的数字"由**引用的对象**决定，不再依赖"什么时候跑完"。
 *
 * 恒等式（并发下也成立）：
 * ```
 * result.written + result.rejectedForeignKey + result.retried == expected
 * ```
 * （`expected` = 本轮真正交给 `domainWrite` / `trackShard` 的事件；
 * 上一轮已发出、结果未回的事件属于**上一轮**，本轮不重复提交也不计入。）
 */
interface FlushRound {
  /** 轮次序号（只用于判断"是不是最新一轮"；不用时间戳，同毫秒会判错） */
  seq: number;
  result: RoundSummary;
  /** 本轮所有分片是否都已结账（诊断用） */
  settled: boolean;
}

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
 * ## ⚠️ 它与 `domainWrite` 的写穿**是两次写**（任务 Y-3：文档曾经与实现矛盾）
 *
 * 这里原来的注释写着"正常路径根本不会走到它 —— 这里只在**那一次失败之后**用同一批行重放"。
 * **那是错的**，实测（审计探针）确认：
 *
 * ```
 * flush() → domainWrite 的写穿（crud.upsert）            # 第 1 次
 *         → trackShard().settle → probe(crud.upsert)     # 第 2 次 —— 无条件发生
 * ```
 *
 * `domainWrite` 的写穿是**异步在飞**的，它把失败 `catch` 掉并上报之后就不再对外表达
 * 任何结果，所以 `trackShard` **根本无从知道"那一次失败了"** ——
 * 于是它只能每次都重放一遍来取错误码。文档说"只在失败后发生"，实现却是无条件发生，
 * 这就是 Y-3 要求消灭的那种"文档与实现互相矛盾"。
 *
 * **为什么不改成"只在失败后才探测"**（那才是原注释描述的形态）：
 * `domainWrite` 不把写穿 Promise 交给调用方（`persistWriteThrough` 里的 `.catch()` 是
 * 终点，`domain-store.ts` 不在本任务的改动范围内），所以"失败信号"在 `trackShard`
 * 这一侧**无法被观察到**。要么改 `domain-store.ts` 让写穿的 Promise 可被订阅
 * （跨出了本任务的文件边界，见报告"需要他人配合"），要么就只能如实承认这 2× 代价。
 * 本任务选了后者：**宁可多一次 IPC，也不要"结账永远判成功"** ——
 * 那会让外键剔除、可重试失败全部退化成静默（正是 C-1 消灭的那类缺陷）。
 *
 * ## 代价与为什么它不产生重复行
 *
 * - 代价：**每个分片每轮 flush 2× IPC / 2× WAL 写入**；
 * - 无重复行：`telemetry_events.id` 是 `TEXT PRIMARY KEY`（`schema.sql`），
 *   而 `crud.upsert` 是 `INSERT OR REPLACE` —— 幂等，重放只是把同一行再写一遍。
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
   *
   * ## 任务 Y-3：它必须是**这一轮 flush 的快照**，不能是共享可变对象
   *
   * 原实现的结构是"实例上一个 `this.counters` + 每次 `flush()` 把它清零"，
   * 而 `settle` 是**异步**的：上一轮的结账在下一轮清零之后才跑完时，
   * 它把**自己那一轮**的数字加进了**新一轮**的计数里。实测（审计）：
   *
   * ```
   * after flush#2: {"written":1,…,"retried":1}   ← 2 条事件被报成"1 条已写 + 1 条待重试"
   * after release: {"written":2,…,"retried":1}   ← 汇总自相矛盾（3 条？批大小只有 2）
   * ```
   *
   * 也就是说：**汇总与它描述的那一批根本不是同一件事**，
   * 而这份汇总正是"诊断遥测为什么没落库"时唯一能看的东西 —— 一个会自相矛盾的
   * 诊断数字比没有数字更坏（它会把排查引向错误的方向）。
   *
   * 现在每次 `flush()` 都新建一个**轮次对象**（`FlushRound`），
   * `trackShard` 只往**它自己那一轮**的对象里累加，迟到结账与并发 flush 因此
   * 互不干扰。恒等式 `written + rejectedForeignKey + retried == expected`（本轮提交数）
   * 在并发下也成立。
   */
  private lastSummary: RoundSummary | null = null;
  /** `lastSummary` 属于哪一轮（防止迟到的旧轮覆盖新轮） */
  private lastSummarySeq = 0;

  /** 最近一次 `flush()` 建的那一轮（用于回答"当前在途的这轮进度如何"） */
  private currentRound: FlushRound | null = null;

  /** 已结账的轮次汇总（按轮次先后；有上限，诊断用） */
  private roundHistory: RoundSummary[] = [];
  private roundCounter = 0;

  /**
   * 最近一次 flush 的汇总（诊断/测试用；异步结账过程中持续更新）。
   *
   * `expected` = 这一轮**提交**的事件数，恒等式
   * `written + rejectedForeignKey + retried == expected` 在并发下也成立
   * （未结账时前者还在增长，所以在途轮次的汇总**暂时**不闭合 —— 这是诚实的，
   * 它表达的正是"还没结完"；结算完成时必须闭合）。
   * 加它是为了让"汇总自相矛盾"这件事**可以被当场验出来** ——
   * 审计实测的 `{written:2, retried:1}`（批大小只有 2）就是这条恒等式被破坏的形态。
   *
   * ## 为什么优先回答"当前这一轮"
   *
   * 如果固定回答"最近**已结账**"的那一轮，那么第 2 轮 flush 刚发出、结果未回时，
   * 这里会返回**第 1 轮**的数字 —— 调用方（诊断面板 / 测试）问的是"刚才那次 flush
   * 怎么样"，得到的却是更早一批的答案，那还是"汇总与批不对应"，只是方向反过来。
   *
   * 判据用**轮次序号**：当前这一轮必须仍是最新的一轮，且它自己还没结账。
   * 否则（它已结账、或它已经被更晚的轮次盖过）返回最新**已结账**的那一轮。
   */
  flushSummary(): RoundSummary | null {
    const current = this.currentRound;
    /*
     * 三轮哨兵：`round.seq > lastSummarySeq` 说明"比已结账的那一轮更晚"，
     * 这一轮的结果才是"最近一次 flush"。在途（`!settled`）时它**暂时不闭合** ——
     * 那是诚实的：它表达的正是"还没结完"。
     */
    if (current && current.seq > this.lastSummarySeq) return { ...current.result };
    return this.lastSummary ? { ...this.lastSummary } : null;
  }

  /**
   * **每一轮** flush 的汇总（诊断/测试用；按轮次先后）。
   *
   * 为什么除了 `flushSummary()` 还要有它：并发 flush 的场景下，
   * "两条事件被两个轮次各写了一条"与"两条事件被同一轮写了两条"是**不同的事实**，
   * 而只看"最近一轮"无法区分。回归测试要钉住的正是"每一轮自己算自己的"。
   */
  flushRoundSummaries(): RoundSummary[] {
    return this.roundHistory.map((r) => ({ ...r }));
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
   * ⚠️ 但它是**无条件发生**的（不是"只在失败后"），代价与理由见 `directWrite()` 的注释。
   *
   * ## 任务 Y-3：计数只写进**本轮的轮次对象**
   *
   * `round` 由 `flush()` 在创建本轮时传入，而 `settle` 是异步的 —— 只认自己那一个对象，
   * 于是"上一轮的结账迟到"不会污染下一轮的汇总（原实现是实例上共享的 `this.counters`，
   * 每次 flush 清零 → 迟到结账把旧数字加进新一轮）。
   * 结账完成时把本轮数字发布到 `lastSummary`，但**只在它仍是最新一轮**时才发布：
   * 旧轮的迟到发布会把"最近一次 flush"换成更早批次的数字，那还是"汇总与批不对应"，
   * 只是换成了跨轮的形态。
   */
  private trackShard(
    sessionId: string,
    shard: TelemetryEvent[],
    rows: Array<Record<string, unknown>>,
    round: FlushRound,
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
        round.result.written += shard.length;
        this.dropFromBuffer(new Set(shard));
        return;
      }
      try {
        await probe(TABLE, rows);
        round.result.written += shard.length;
        // 确认落库 → 才允许从缓冲里去掉（C-1 要求 ③）
        this.dropFromBuffer(new Set(shard));
      } catch (err) {
        if (isDeterministicRejection(err)) {
          // 确定性拒绝：剔除 + 上报。**不重发**（重发会永远失败 → 无限重试风暴）
          round.result.rejectedForeignKey += shard.length;
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
        round.result.retried += shard.length;
      }
    })()
      .catch(() => {
        /* 结账自身出错绝不影响功能 */
      })
      .finally(() => {
        round.settled = true;
        /*
         * 历史留痕：每轮结账时把**本轮**的数字存一份（诊断/测试要能逐轮看到）。
         * 超过上限就丢最旧的 —— 它只是诊断数据，不值得为它撑大常驻内存。
         */
        this.roundHistory.push({ ...round.result });
        if (this.roundHistory.length > FLUSH_ROUND_HISTORY_MAX) this.roundHistory.shift();
        /*
         * 发布：迟到的旧轮**不允许**覆盖"最近一次 flush" —— 那还是"汇总与批不对应"，
         * 只是换成了跨轮的形态（旧批的数字冒充新批的）。用序号比较，不用时间戳。
         */
        if (!this.lastSummary || round.seq > this.lastSummarySeq) {
          this.lastSummarySeq = round.seq;
          this.lastSummary = { ...round.result };
        }
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
       * 任务 Y-3：**每次 `flush()` 都建一个自己的轮次对象**（哪怕这一轮一条都没提交）——
       * 计数不再放在实例字段上（那样会被下一轮清零、被上一轮的迟到结账污染），
       * 而是**每轮一个新对象**，随 `trackShard` 一起传下去。它同时是
       * `written + rejectedForeignKey + retried == expected` 这条恒等式的载体。
       *
       * ⚠️ 创建位置在 `bySession` 分发**之前**：否则"这一轮全部事件都还在途
       * （`fresh` 全空）"时就不会有轮次对象，`flushSummary()` 会退回**上一轮**的数字
       * —— 又是"汇总与批不对应"，只不过这次是"新的一次 flush 报了旧一批的账"。
       */
      const round: FlushRound = {
        seq: ++this.roundCounter,
        result: { written: 0, rejectedForeignKey: 0, retried: 0, expected: 0 },
        settled: false,
      };
      this.currentRound = round;

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

      for (const [sessionId, group] of bySession) {
        const fresh = group.filter((e) => !alreadyInFlight.has(e));
        /*
         * 本轮**确实提交**的事件数 —— 恒等式的右边。
         *
         * ⚠️ 原来这里写的是 `this.counters.retried += group.length - fresh.length;`，
         * 把"上一轮已经发出、结果未回"的事件也算成"本轮待重试"。那既让恒等式失真
         * （本轮一条都没提交，汇总里却有 `retried: 1`），也让 `flushSummary()` 看起来
         * 与"这一批"矛盾 —— 正是 Y-3 要消灭的自相矛盾汇总。
         * 已发出的事件由**它自己那一轮**负责结账（`round.result.retried`），
         * 本文这一轮对它们唯一该做的事就是"不重复提交"。
         */
        if (fresh.length === 0) continue;
        // 恒等式的右边：这几条是**本轮**提交的（无论最后是写成功、被剔除还是待重试）
        round.result.expected += fresh.length;

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
          // 与 `trackShard` 的"可重试失败"同一语义：这批留在缓冲里，本轮如实记为待重试
          round.result.retried += fresh.length;
          continue;
        }

        // 本片交给结账：成功/确定性拒绝才从缓冲里去掉，其余留在缓冲里等重试。
        this.trackShard(sessionId, fresh, rows, round);
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
    /*
     * `null` = **未接手**（`domainDeleteWhere` 的契约：`0` 是"接手了、确实没有要删的行"，
     * 两者绝不能压成同一个值 —— `domain-mirror-window.test.ts` 的 WIN-6 就钉着这条）。
     *
     * 上面那次读已经把"镜像没就绪"挡掉了，所以走到这里还为 `null` 属于窗口内的状态翻转
     * （读与删之间被逐出/撤销）。**"理论上不可达"不等于"可以静默"**：`?? 0` 会把它变成
     * "没有可清空的遥测事件"，而函数上方那段注释恰好承诺了"没删成一定伴随上报" ——
     * 注释与实现不一致正是这个仓库查出过最多缺陷的形态，所以这里按契约如实上报。
     */
    if (removed === null) {
      reportPersistFailure(
        "telemetry.clearAll",
        new Error("删除时端口未接手（域镜像在读取之后失去就绪）"),
        "遥测事件未清空（本次没有清空任何行）",
      );
      return 0;
    }
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

/**
 * **仅供测试**：换一个全新的采集器实例，并把旧实例的重试定时器清掉。
 *
 * 为什么需要它：采集器是**模块级单例**（生产上正确：一个进程一份遥测缓冲），
 * 但同文件里的用例会互相影响 —— 上一条用例留下的"在途事件 / 未结账的轮次"
 * 会被下一条用例的 `flush()` 看见（甚至写进另一条用例的假端口）。
 * 那会让回归测试的成败取决于**用例顺序**，而本任务要钉的恰恰是
 * "并发 flush 下计数属于哪一轮"这种时序语义 —— 靠顺序碰运气的测试等于没测。
 *
 * 名字带 `__` 前缀：生产代码不调用它。
 */
export function __resetTelemetryForTests(): void {
  /*
   * `flushTimer` 是私有字段，这里刻意用一次断言读它：**必须**把旧实例的重试定时器清掉，
   * 否则上一个用例排下的那次 `flush()` 会在下一个用例里触发，去写那个用例的假端口。
   * （另一种写法是给类加一个 `stop()`，但那会变成生产 API —— 生产上不需要"停掉遥测"。）
   */
  const timer = (collector as unknown as { flushTimer: ReturnType<typeof setTimeout> | null } | null)?.flushTimer;
  if (timer) clearTimeout(timer);
  collector = new TelemetryCollector();
}
