/**
 * Event Log — Append-only event storage
 *
 * Design (对标 DeepSeek Harness event-sourcing):
 * - Events are appended to SQLite session_events table
 * - Never updated in place（唯一删事件的路径是本文件的 `compactWithSnapshot`，
 *   而它**没有生产调用者**，见该方法自己的说明）
 * - **不是** session state 的真相之源 —— 消息的权威是 JSONL（见下）
 * - **不是** session state 的真相之源 —— 消息的权威是 JSONL（见下）
 * - Projection functions derive messages from events, 但投影**不进 LLM 上下文**
 *
 * ## 第 84 波（功能上下文审计 P5）：改掉"Source of truth"这条假陈述
 *
 * 这里原来写的是 "- Source of truth for session state" 与下面的
 * "Phase 2: buildMessages() reads from event projection" —— **两句都与实现相反**：
 *
 * - **消息的权威是 `messages` 表，其权威副本是 JSONL 追加日志**（SQLite 索引可重建）：
 *   `session-jsonl.ts:10-19`；读侧 `agentic-loop.ts:2853-2862`（`buildMessages()` 读
 *   `listMessages()`，注释原文 "DB CRUD is the single source of truth for LLM messages.
 *   The event log … is used for telemetry and audit only, **NOT** for message projection"）。
 * - **"Phase 2" 从未发生**，而且已被明确否决：`agentic-loop.ts:31` 的墓碑写着
 *   `// deriveMessagesFromEvents removed`。三阶段迁移里只有 Phase 1（双写）落地，
 *   Phase 3（删旧 CRUD）也没走这条路，而是"JSONL 做权威 + SQLite 做可重建索引"。
 * - 事件自身**确实是**自身事件的权威（append-only，且 `maintenance.ts:1223` 写明
 *   `session_events` 是"唯一没有等价物"的存储）—— 但那是"事件不可重建"，
 *   不是"事件是会话状态的真相"。两件事不要混。
 *
 * 准确的说法：**事件日志是 telemetry/audit 与派生读的来源，不是消息的权威。**
 * 投影今天活着的消费者只有 `projectSurface`（进系统提示词一行状态）与
 * `validateReplay`（维护自检），详见 `event-projection.ts` 模块头。
 */

import { getStoragePort, hasStoragePort } from "./port";
import { reportPersistFailure } from "./persist-failure";

// ========== 迁移期：事件镜像分流（P3 第 4 段） ==========
//
// 端口是 rust 且事件镜像**已预热**时，读写都走镜像：
// - 读：同步（镜像整份在内存里，事件本来就要整份读来回放）；
// - 写：同步返回 + 发件箱异步落库（接口是同步的，而 IPC 是异步的，只能这样解）。
//
// 镜像未预热（尚未启动完 / 预热失败）时**完全走原路径** —— 功能不中断。
// 这正是回滚开关能生效的前提。

/**
 * "加载窗口期"内的 append 需要补进镜像与 Rust 库时用的缓冲。
 *
 * ## 为什么需要它
 *
 * 某会话的事件加载是后台进行的（几百毫秒）。在那个窗口里 `isLoaded` 还是 false，
 * 所以 append 走的是**旧库**。等加载完成、切到镜像后，那几条事件就只在旧库里了 ——
 * 表现为"刚发的消息在事件日志里消失"。契约测试 EV-5 正是抓这个。
 *
 * 解法：窗口期内的 append 记在这里，加载完成后补写进 Rust 库（发件箱）
 * 并放进镜像，于是**两处最终一致**，一条都不丢。
 *
 * ⚠️ **L4 收尾后它已没有生产者**：唯一调用点原来在 `append` 的**旧库写入分支**里
 * （那里有一条真实 seq 要补进镜像）。那条分支删除后，窗口期 append 一律走
 * `appendViaMirror()`：占位 seq 由 `RustEventMirror.loadSession` 原样保留
 * （`pendingLocal`）并在落库后 `reconcile` 成真实水位，所以**不存在事件丢失**。
 *
 * ## 第 62 轮：已删除（原来是"保留但无生产者"）
 *
 * 上一版的注释写着"保留，不删"（理由是"属于端口侧补偿机制，删它要连带改回调"）。
 * 但**一个没有任何生产者的缓冲 + 一段永远不会执行的补写回调**留在读路径里，
 * 正是本仓库反复清理的那种"看起来在工作、其实永远空转"的代码
 * （稳定性审计也把它列为死代码）。本轮按"遗留物就清理"处理：连同它的写入函数与回调一起删掉，
 * `ensureLoaded` 仍然照常触发惰性加载（那是 `ensureLoaded` 自身的副作用，与这个回调无关）。
 */

type RustEventPortLike = {
  events: {
    readAll(s: string): Array<{ seq: number; sessionId: string; type: string; payload: string; timestamp: number }>;
    readFrom(s: string, from: number): Array<{ seq: number; sessionId: string; type: string; payload: string; timestamp: number }>;
    readRange(s: string, from: number, to: number): Array<{ seq: number; sessionId: string; type: string; payload: string; timestamp: number }>;
    latestSeq(s: string): number;
    count(s: string): number;
    isLoaded(sessionId: string): boolean;
    ensureLoaded(sessionId: string, onLoaded?: () => void): void;
    appendLocal(s: string, type: string, payload: string, timestamp: number): { seq: number };
    replaceSession(s: string, events: Array<{ seq: number; sessionId: string; type: string; payload: string; timestamp: number }>): void;
  };
  appendEventAsync(s: string, type: string, payload: string, timestamp: number, placeholderSeq: number): void;
  appendEventBatchAsync(s: string, events: Array<{ type: string; payload: string; timestamp: number; placeholderSeq: number }>): void;
  compactEventAsync(s: string, snapshotSeq: number, cutoffSeq: number, payload: string): void;
  deleteEventsAsync(s: string): void;
};

/**
 * 取该会话可用的 Rust 事件通道 —— **不同步加载完就返回 null**。
 *
 * 这是"消除读写分裂"的关键判断：只有某会话的事件**已经完整加载进镜像**后，
 * 才允许它的读写都走镜像。否则调用方继续用旧路径，读到的与写到的在同一个地方，
 * 不会出现"写进镜像、读从旧库"的错位。
 *
 * 副作用是：每次调用都会顺带触发一次惰性加载（同步返回，后台进行），
 * 因此最迟在该会话第二次访问时就会切到镜像。
 */
function rustEventPort(sessionId?: string): RustEventPortLike | null {
  if (!hasStoragePort()) return null;
  // 第 19 轮：`if (port.kind !== "rust") return null;` 已删（`kind` 是常量 "rust"，恒不成立）。
  const candidate = getStoragePort() as unknown as RustEventPortLike;
  if (!candidate.events?.ensureLoaded) return null;
  if (sessionId === undefined) return candidate;
  // 触发一次惰性加载（同步返回，后台进行）——加载完成后**不再有"补写窗口期事件"这件事**：
  // 那条缓冲已随本轮清理删除（见文件头），窗口期 append 走镜像的 pendingLocal 机制。
  candidate.events.ensureLoaded(sessionId);
  return candidate.events.isLoaded(sessionId) ? candidate : null;
}

/**
 * 取该会话的 Rust 事件通道 —— **不看是否加载完**（第 12 轮新增）。
 *
 * ## 为什么"未加载完"也必须由端口接手
 *
 * `rustEventPort()` 的规则是"未加载完不路由"，那条规则的目的是**避免读写分裂**
 * （写进镜像、读还从旧库）。但在 rust 引擎下旧库**刻意不存在** —— 没有旧库可分裂，
 * 那条规则的代价就只剩"写路径直接抛错"：真机上表现为事件日志在启动窗口期整段丢失
 * （`EventLog.append` 第一行就 `getDatabase()` 抛）。
 *
 * 镜像侧对"加载窗口期写入"是有准备的：`appendLocal` 分配的占位 seq 会被
 * `RustEventMirror.loadSession` **保留下来**（`pendingLocal` 过滤后追加在真实行之后），
 * 加载完成后由 `reconcile` 把占位 seq 对账成真实水位。所以窗口期写入是安全的。
 */
function rustEventPortAny(): RustEventPortLike | null {
  if (!hasStoragePort()) return null;
  // 第 19 轮：`if (port.kind !== "rust") return null;` 已删（恒不成立）。
  const candidate = getStoragePort() as unknown as RustEventPortLike;
  // 用对象存在性判断（不要判 `appendLocal` 这种"函数是否定义"—— 类型上它必然存在，
  // `tsc` 会直接报 TS2774：这种守卫等于没写）
  return candidate.events ? candidate : null;
}

/** 镜像事件 → SessionEvent（payload 是 JSON 文本，要解析回来） */
function toSessionEvent(e: { seq: number; sessionId: string; type: string; payload: string; timestamp: number }): SessionEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(e.payload || "{}") as Record<string, unknown>;
  } catch {
    payload = { _raw: e.payload };
  }
  return {
    seq: e.seq,
    sessionId: e.sessionId,
    type: e.type as SessionEventType,
    payload,
    timestamp: e.timestamp,
  };
}

/** 发射到 TypedEventBus（原逻辑抽出来，两条路径共用） */
function emitToBus(event: SessionEvent): void {
  import("../llm/event-system-strict")
    .then(({ getTypedEventBus }) => {
      getTypedEventBus().emit(event).catch(() => {});
    })
    .catch(() => {
      // Non-critical — event bus is optional
    });
}
import type { SessionEvent, SessionEventType } from "./event-types";
import { isValidEventType } from "./event-types";

// ========== Schema ==========

export const EVENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);
`;

// ========== Event Log Implementation ==========

/**
 * 写入侧守卫：**事件类型名必须在权威集合里**（第 68 轮补）。
 *
 * ## 为什么要有它（真机取证）
 *
 * `ui-trajectory-provider.ts` 一直在写 `trajectory_step`、`loop-stop-log.ts` 一直在写
 * `loop_stopped`，两个名字都不在 `event-types.ts` 的权威集合里 —— 写进去时没人拦，
 * 直到维护的结构自检把它们**逐条**报成 `Unknown event type`：真机一次维护报
 * **7360 处结构异常**，还带着"该功能本次没有生效"的措辞。事件是**唯一没有等价物**的存储，
 * 它的自检被这种噪声淹没，等于没有自检。
 *
 * ## 处置：**只拦不丢、在源头如实上报**
 *
 * - **不抛**：写入侧抛错会让上游"因为一个类型名没登记"丢掉一条真实事件（更坏的结果）；
 * - **不自动登记**：这一条是刻意选的。自动登记等于"凡是被写过的类型都合法" ——
 *   那结构自检就再也检不出类型漂移了（判据被自己抹平，正是本项目最忌讳的
 *   "印出来的不是真的"）。所以**权威集合说了算**，写进来的野类型照样会被自检报出来；
 * - **同一个名字只报一次**（热路径不刷屏）：把"这里有个没登记的类型"这件事
 *   在**产生它的地方**说清楚，而不是等维护时一次吐几千条。
 *
 * 静态能查的（字面量、同文件常量）由 `src/test/event-type-write-sites.test.ts` 在提交前拦住；
 * 这里兜的是**运行期才知道的类型名**（插件从配置/市场读出来的名字）。
 */
const warnedUnknownEventTypes = new Set<string>();

function guardEventType(type: SessionEventType | string): void {
  const name = String(type);
  if (isValidEventType(name)) return;
  if (warnedUnknownEventTypes.has(name)) return;
  warnedUnknownEventTypes.add(name);
  /**
   * ⚠️ 上报的 area **带上类型名**：`persist-failure` 的失败表是按 **area** 去重的，
   * 用同一个 area 会让"两种野类型"合成一条、而且只留下**第一个**名字
   * （第一版就是这样：第二个名字在界面上根本看不见）。
   */
  reportPersistFailure(
    `eventLog.unknownType.${name}`,
    new Error(`未注册的事件类型：${name}`),
    `事件**照样写入**（不丢数据），但这个名字不在权威集合里 ⇒ 维护的"事件库结构自检"` +
      `会把它的**每一条**都算成结构异常（真机实测 7360 条，把真问题淹了）。` +
      `请把它加进 src/core/storage/event-types.ts 的 BUILTIN_EVENT_TYPES，或在写入方 registerCustomEventType()。`,
  );
}

/** 测试用：清掉"已上报过的未注册类型"记忆 */
export function __resetUnknownEventTypeWarnings(): void {
  warnedUnknownEventTypes.clear();
}

export class EventLog {
  private static instance: EventLog | null = null;

  static getInstance(): EventLog {
    if (!EventLog.instance) {
      EventLog.instance = new EventLog();
    }
    return EventLog.instance;
  }

  /**
   * Append an event to the log. The event is stored immutably.
   * Returns the event with its assigned sequence number.
   */
  append(
    sessionId: string,
    type: SessionEventType | string,
    payload: Record<string, unknown>,
  ): SessionEvent {
    guardEventType(type);
    // 路由到镜像的**唯一条件**：该会话的事件已完整加载（见 rustEventPort 注释）。
    // 未加载完 → 由下面的 `rustEventPortAny()` 接手（占位 seq 会被加载逻辑保留）。
    const routed = rustEventPort(sessionId);
    if (routed) return this.appendViaMirror(routed, sessionId, type, payload);
    /**
     * B 态（端口在 rust、该会话事件镜像还没加载完）：**仍然由端口接手**（第 12 轮）。
     *
     * 这里原来是"未加载完就继续走下面的旧库路径" —— 那条规则在 wasm 时代是对的
     * （避免读写分裂），但在 rust 模式下旧库刻意不存在，`getDatabase()` 直接抛：
     * 用户看到的是"刚发的消息在事件日志里消失"。镜像对窗口期写入有准备
     * （见 `rustEventPortAny` 的注释：占位 seq 会被加载逻辑保留、随后 reconcile）。
     */
    const anyPort = rustEventPortAny();
    if (anyPort) return this.appendViaMirror(anyPort, sessionId, type, payload);

    /**
     * **B 态（端口在但缺事件能力）与 A 态（端口未接手）在这里合流**：
     * 两者的正确处置**恰好相同** —— 都不碰旧库，都**如实上报**，
     * 并返回一个**未落库**的事件（seq=0）。
     *
     * - 不抛是刻意的（原注释保留）：事件日志是"可重建的投影源"，
     *   让它炸掉上层消息写入的代价更大；
     * - `seq=0` 是**如实的失败形状**，不是成功：它告诉调用方"这条没有 seq、
     *   不在持久日志里"（原来 A 态会静默写进旧库，而读路径只认镜像 —— 写成读写分裂，
     *   且引擎启动失败时旧库同样不可用，那份写入根本无处可读）。
     *
     * 旧库写入（`getDatabase()` + INSERT + `persistDatabase()`）已在 L4 收尾时删除。
     */
    reportPersistFailure(
      "eventLog.append",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "事件未写入（端口侧事件通道不可用）",
    );
    const timestamp = Date.now();
    const event: SessionEvent = { seq: 0, sessionId, type: type as SessionEventType, payload, timestamp };
    emitToBus(event);
    return event;
  }

  /**
   * 迁移期**预留**：走镜像 + 发件箱的追加实现（当前未接线）。
   *
   * ⚠️ 为什么这轮不能直接接上：只追加面的"读"依赖镜像预热（需要启动时先枚举会话），
   * 而那一步尚未接线。如果现在就让 `append` 走镜像、读还走旧库，会形成**读写分裂**：
   * 新事件进了镜像与 Rust 库，但 `readAll` 从旧库读、看不到它们 —— 比不迁移更糟。
   *
   * 所以这里保留实现待用，预热与接线一并放到下一步（Rust 侧命令与镜像/发件箱已就绪）。
   */
  private appendViaMirror(
    port: RustEventPortLike,
    sessionId: string,
    type: SessionEventType | string,
    payload: Record<string, unknown>,
  ): SessionEvent {
    const timestamp = Date.now();
    const payloadStr = JSON.stringify(payload);
    const placeholder = port.events.appendLocal(sessionId, String(type), payloadStr, timestamp);
    port.appendEventAsync(sessionId, String(type), payloadStr, timestamp, placeholder.seq);
    const event: SessionEvent = {
      seq: placeholder.seq,
      sessionId,
      type: type as SessionEventType,
      payload,
      timestamp,
    };
    emitToBus(event);
    return event;
  }

  /**
   * Append multiple events in a single transaction.
   * All events get consecutive sequence numbers.
   */
  appendBatch(
    sessionId: string,
    events: Array<{ type: SessionEventType | string; payload: Record<string, unknown> }>,
  ): SessionEvent[] {
    for (const evt of events) guardEventType(evt.type);
    // 与 append 同样的分流：该会话已加载完 → 走镜像 + 批量发件箱（单事务、seq 连续）
    const routed = rustEventPort(sessionId) ?? rustEventPortAny();
    if (routed) {
      const timestamp = Date.now();
      const prepared = events.map((evt) => {
        const payloadStr = JSON.stringify(evt.payload);
        const placeholder = routed.events.appendLocal(sessionId, String(evt.type), payloadStr, timestamp);
        return { type: String(evt.type), payload: payloadStr, timestamp, placeholderSeq: placeholder.seq };
      });
      routed.appendEventBatchAsync(sessionId, prepared);
      return prepared.map((p, i) => ({
        seq: p.placeholderSeq,
        sessionId,
        type: events[i].type as SessionEventType,
        payload: events[i].payload,
        timestamp,
      }));
    }

    /**
     * **端口没接手 → 如实返回"未落库"的事件（seq=0）并上报失败**（不抛，理由同 append）。
     *
     * 与 `append` 一样，"端口在但缺事件能力"和"端口未注册"在这里合流：
     * 两者都不该碰旧库（rust 模式下旧库刻意不存在；引擎启动失败时它同样不可用）。
     * 旧库写入（BEGIN/INSERT/COMMIT + `persistDatabase()`）已在 L4 收尾时删除。
     */
    reportPersistFailure(
      "eventLog.appendBatch",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "批量事件未写入（端口侧事件通道不可用）",
    );
    const timestamp = Date.now();
    return events.map((evt) => ({
      seq: 0,
      sessionId,
      type: evt.type as SessionEventType,
      payload: evt.payload,
      timestamp,
    }));
  }

  /**
   * 事件日志压缩：先写**快照事件**，再删除它之前的事件（第 77 波）。
   *
   * 为什么必须"先快照后删除"：事件日志被 `event-projection` 当作状态读取，
   * 直接按 seq 截断会让投影缺段（上一波审计因此把裁剪默认关掉了）。
   * 快照把当时的投影状态固化成一个事件，回放 = 快照 + 其后事件，
   * 与完整回放**等价**（`snapshot-compaction.test.ts` 的 SNAP-2 守着这条）。
   *
   * 实现要点（踩过的坑）：快照必须**占据锚点事件自己的 seq**，不能用新的最大 seq。
   * 否则快照会排到"要保留的尾部事件"之后，而 `applySnapshot` 是**替换**语义 ——
   * 回放时那批尾部事件会先被应用、再被快照覆盖掉，等于把刚发生的对话弄丢。
   * 用 `INSERT OR REPLACE` 占位后：回放顺序仍是 [……, 快照@anchor, 尾部事件……] ✓
   *
   * ## 第 84 波：**零生产调用者**（本文件里**唯一的删事件路径**）
   *
   * 这是整个事件日志里唯一会**删事件**的方法，而它今天**没有任何生产调用者**：
   * 启动维护刻意不接（`maintenance.ts` 里 `prunedEvents`/`compactedSessions`
   * 恒为 0 的长注释就是这条决定），全仓调用点只有
   * `snapshot-compaction.test.ts` 与 `dsh-integration-full.test.ts`。
   * 于是它是一个**高危但只靠注释守着**的能力：一旦被接上，旧事件就没了，
   * 而 `session_events` 是"唯一没有等价物、不可重建"的存储（`maintenance.ts:1223`）。
   * 要接它，先把 `maintenance.ts` 那段论据逐条复核一遍（尤其"快照载荷只固化了投影，
   * 而 `runtime-invariants` 等消费方读的是**事件**"这一条）。
   *
   * @param projectUpTo 用"截至锚点的事件"计算快照载荷（保持 storage 层不反向依赖 projection）
   * @returns 删除的事件数与快照 seq
   */
  compactWithSnapshot(
    sessionId: string,
    projectUpTo: (events: SessionEvent[]) => Record<string, unknown>,
    opts: { keepEvents?: number } = {},
  ): { removedEvents: number; snapshotSeq: number } {
    const events = this.readAll(sessionId);
    if (events.length === 0) return { removedEvents: 0, snapshotSeq: 0 };

    const keepEvents = Math.max(0, opts.keepEvents ?? 0);
    const cutoffIndex = events.length - keepEvents; // 锚点之后的事件要保留
    if (cutoffIndex <= 0) return { removedEvents: 0, snapshotSeq: 0 };
    const anchor = events[cutoffIndex - 1];

    // 快照载荷 = 锚点及其之前所有事件的投影结果
    const payload = projectUpTo(events.slice(0, cutoffIndex));
    const payloadStr = JSON.stringify({
      ...payload,
      atSeq: anchor.seq,
      compactedAt: Date.now(),
      coveredEvents: cutoffIndex,
    });

    /**
     * P5 第 10 段（**修一个"压缩是空操作"的真实缺陷**）。
     *
     * 这个方法原来是"读走镜像、写走旧库"：上面的 `readAll` 在端口就绪后从镜像读，
     * 而下面的快照写入 / 删除**只对旧库生效**。后果是 rust 引擎下压缩**什么都没删**
     * —— 旧库里被删得干干净净（无人读），镜像里毫发无损（这才是读的那份），
     * 于是"压缩了 N 条、上下文一点没小"再次发生，只是这次的机制不同。
     *
     * 现在与 `deleteAllForSession` 用同一套写法：**镜像先更新（读立刻一致）→ 真实写排队**。
     */
    const routed = rustEventPort(sessionId);
    if (routed) {
      const anchorSeq = anchor.seq;
      const now = Date.now();
      /**
       * ## `cutoff_seq` 怎么算（第 20 轮，真引擎取证——这是 B-2 的真 bug）
       *
       * Rust 侧 `events.compact` 是两条 SQL（`repo.rs::events_compact`）：
       * 1. `INSERT OR REPLACE` 快照到 `snapshot_seq`（= 锚点自己的 seq）；
       * 2. `DELETE … WHERE seq < cutoff_seq AND event_type <> 'session_meta'`
       *    —— **排他上界**，且 `session_meta` 永不删。
       *
       * 于是保留集合必然是 `seq >= cutoff_seq ∪ {session_meta}`。
       * **镜像必须逐条对齐这个集合**（否则 `readAll` 重新加载后读到的集合会突然变），
       * 而"快照自己"也必须活下来 —— 它是这次压缩的全部意义。
       *
       * ### 之前错在哪
       *
       * 原代码在"无尾部事件"（`keepEvents` 缺省 = 0，也是唯一默认值）时取
       * `cutoff_seq = anchorSeq + 1`。看着像"删掉锚点及其之前的一切"，实际是
       * `seq < anchorSeq + 1` —— **把刚写进锚点 seq 的快照自己也删掉了**。
       * 真 CLI 实测（事件 seq 1..8，锚点 8，`snapshot_seq=8`）：
       *
       * | `cutoff_seq` | 引擎返回 | 库内 `events.list` |
       * | --- | --- | --- |
       * | **9**（= 锚点+1，原代码） | `removed_events: 7` | **只剩 `session_meta@1`（快照没了）** |
       * | **8**（= 锚点，现代码） | `removed_events: 6` | `session_meta@1` + `session_snapshot@8` ✓ |
       *
       * 也就是说原注释写的"取锚点自己 → 快照又被删掉"是记反的：**取锚点+1 才会删掉快照**。
       * 这个 bug 之所以在测试里看不见，是因为假端口当时多两条豁免
       * （`seq !== snapshotSeq`、`event_type !== 'session_snapshot'`，比真引擎宽松）——
       * 那两条豁免已由引擎侧工作者删除（`fake-storage-port.ts` 的 A-7），缺陷随即在
       * SNAP-1/2/3 上现形。
       *
       * ### 现在的取法
       *
       * - **有尾部事件**（`keepEvents > 0`）：`cutoff_seq` = 第一条被保留尾部事件的 seq
       *   （尾部本来就是序列最大的一段，与 `seq < cutoff` 逐字等价）；
       * - **无尾部事件**：`cutoff_seq` = `anchorSeq`（**不是** `anchorSeq + 1`）——
       *   删除只在锚点**之前**生效，锚点位置已被换成快照，于是"只留下快照"才是真的。
       *
       * ⚠️ 不能取 `Number.MAX_SAFE_INTEGER` 当"足够大的上界"：真引擎实测该值**报错**
       * （Rust 的 `req_i64` 用 `as_i64()`，serde_json 把这种字面量解析成 f64 → None）。
       *
       * ⚠️ `anchor.seq` 可能是**字符串**（镜像/历史数据没数值化）：`"8" + 1` 会变成 `"81"`，
       * 而 `seq < 81` 会把锚点之后的一切都删掉。所以这里一律先 `Number()`。
       */
      const anchorNum = Number(anchorSeq);
      const seqNumbers = events.map((e) => Number(e.seq)).filter((n) => Number.isFinite(n));
      const maxSeq = seqNumbers.length > 0 ? Math.max(...seqNumbers) : anchorNum;
      const firstKept = events[cutoffIndex];
      /**
       * **无尾部时的守卫**：锚点若不是最高位事件，说明镜像里的 seq 非单调
       * （正常路径下 `readAll` 按 seq 排序返回、`appendLocal` 的本地占位也大于水位，
       * 所以这条分支在产品里不可达）。此时 `cutoff_seq = anchorNum` 仍会**留下**锚点之上
       * 那些非 meta 行（`seq >= cutoff_seq`），而镜像按下标把它们剔了 —— 两边不一致。
       * 与其静默产生分歧，不如**不落库**并如实上报：权威侧保持原样，代价只是"这次没省空间"。
       */
      const hasNonMetaAboveAnchor = events.some(
        (e, i) => i > cutoffIndex - 1 && Number(e.seq) > anchorNum && e.type !== "session_meta",
      );
      let cutoffSeq: number;
      if (firstKept !== undefined) {
        cutoffSeq = Number(firstKept.seq);
      } else if (!hasNonMetaAboveAnchor) {
        cutoffSeq = anchorNum;
      } else {
        reportPersistFailure(
          "eventLog.compact",
          new Error("锚点之上存在非 session_meta 事件，cutoff_seq 无法同时保住快照与集合一致"),
          `会话 ${sessionId} 的事件压缩未落库（锚点 seq=${anchorNum}、最大 seq=${maxSeq}）：` +
            `一条 seq 上界表达不了"只保留快照"；权威侧保持原样，本次只是没有省下空间`,
        );
        return { removedEvents: 0, snapshotSeq: anchorNum };
      }
      /**
       * ## 镜像的保留集合必须**逐条对齐引擎的删除规则**（不能按"我猜它删了哪些"来写）
       *
       * 之前这里是 `events.filter((e, i) => i >= cutoffIndex || e.type === "session_meta")` ——
       * 那个集合**不含锚点自己**（锚点下标是 `cutoffIndex - 1`），于是"镜像留下的"里
       * 从来没有快照：SNAP-1/2/3 在假端口变严格之后立刻红（`readAll` 里看不到 `session_snapshot`）。
       * 现在按引擎规则取：`seq >= cutoff_seq` ∪ `session_meta` —— 锚点（秒=快照）自然在其中。
       */
      const replaced = events
        .filter((e) => Number(e.seq) >= cutoffSeq || e.type === "session_meta")
        .map((e) =>
          Number(e.seq) === anchorNum
            ? {
                seq: anchorNum,
                sessionId,
                type: "session_snapshot",
                payload: payloadStr,
                timestamp: now,
              }
            : {
                seq: Number(e.seq),
                sessionId,
                type: String(e.type),
                payload: JSON.stringify(e.payload ?? {}),
                timestamp: e.timestamp,
              },
        );
      /**
       * 锚点若本身就是 `session_meta`（它在 filter 里被保留、但不是快照位置），要单独补上快照。
       * 用 `Number()` 比较：`seq` 从镜像读回来时可能是字符串，`===` 会漏判。
       */
      if (!replaced.some((e) => Number(e.seq) === anchorNum)) {
        replaced.push({
          seq: anchorNum,
          sessionId,
          type: "session_snapshot",
          payload: payloadStr,
          timestamp: now,
        });
      }
      replaced.sort((a, b) => a.seq - b.seq);
      const removedEvents = Math.max(0, events.length - replaced.length);
      /**
       * ## ⚠️ 顺序：**先"写穿"（引擎那两条 SQL），再刷镜像**
       *
       * 踩过一次（第 20 轮）：原来是"先 `replaceSession`（镜像乐观更新）→ 再
       * `compactEventAsync`（写穿）"。**假端口就是库本身**（它的 `replaceSession` 改的正是
       * 那张表），于是随后写穿的删除把刚放进镜像的快照又删掉了 ——
       * SNAP-8 的表现是"镜像里没有快照"，看起来像镜像逻辑写错了，其实是顺序错了。
       *
       * 真实端口下这条顺序同样是对的：`appendLocal` 的本地占位是"远大于水位"的高 seq，
       * 重放后不会打乱顺序；而"先算清楚引擎会留下什么、再按那个集合刷镜像"才能保证
       * **镜像与权威侧逐条一致**（`replaceSession` 只在权威侧落地后才有意义）。
       */
      routed.compactEventAsync(sessionId, anchorNum, cutoffSeq, payloadStr);
      routed.events.replaceSession(sessionId, replaced);
      return { removedEvents, snapshotSeq: anchorNum };
    }

    /**
     * **端口没接手（事件通道不可用 / 端口未注册）→ 同上，绝不碰旧库。**
     *
     * 返回 `removedEvents: 0` 是**如实**的结果（本次一条都没删，快照也没写），
     * 并已上报为一次持久化失败。
     * 旧库那两条 SQL（`INSERT OR REPLACE` 快照 + `DELETE … seq < anchor`）
     * 已在 L4 收尾时删除：rust 模式下旧库刻意不存在，写进去也无人读。
     */
    reportPersistFailure(
      "eventLog.compact",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "事件压缩未落库（端口侧事件通道不可用）",
    );
    return { removedEvents: 0, snapshotSeq: anchor.seq };
  }

  /**
   * 读所有事件（含快照）。顺序保证：快照一定排在其覆盖的事件之后（seq 单调）。
   */
  readAll(sessionId: string): SessionEvent[] {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.readAll(sessionId).map(toSessionEvent);
    /**
     * **旧库读取已删除**（L4 收尾）：端口没接手 → 该域的合理空结果（空数组）。
     * 与原来门控里那句 `if (!shouldFallbackToLegacy()) return [];` **语义一致**。
     *
     * ⚠️ 这里返回空**不会丢事件**：事件日志是"读不到就当成没有"的投影源，
     * 权威副本在 Rust 库；端口没接手时这个进程本来也读不到它（旧库已移除）。
     * 调用方（投影 / 压缩 / fork）看到空日志的后果是"这次会话看起来没有历史"，
     * 而不是"把已有历史删掉" —— 没有任何删除路径会因为这里返回空而被触发。
     */
    return [];
  }

  /**
   * Read events from a specific sequence number onward.
   * Used for incremental projections.
   */
  readFrom(sessionId: string, fromSeq: number): SessionEvent[] {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.readFrom(sessionId, fromSeq).map(toSessionEvent);
    // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致；旧库已移除）
    return [];
  }

  /**
   * Read events in a range (for pagination).
   */
  readRange(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[] {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.readRange(sessionId, fromSeq, toSeq).map(toSessionEvent);
    // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致；旧库已移除）
    return [];
  }

  /**
   * Get the latest sequence number for a session.
   * Returns 0 if no events exist.
   */
  getLatestSeq(sessionId: string): number {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.latestSeq(sessionId);
    // 端口没接手 → 0（"没有已知事件"），与原来门控那句 `return 0` 语义一致；旧库已移除
    return 0;
  }

  /**
   * Count events for a session.
   */
  count(sessionId: string): number {
    const routed = rustEventPort(sessionId);
    if (routed && routed.events.isLoaded(sessionId)) return routed.events.count(sessionId);
    // 端口没接手 → 0，与原来门控那句 `return 0` 语义一致（旧库已从渲染进程移除）
    return 0;
  }

  /**
   * 删除某会话的全部事件。
   *
   * ## ⚠️ 第 55 轮更正了这里的两句不实说法
   *
   * 原文：*"Delete all events for a session (used when session is deleted).
   * This is the ONLY deletion path — individual events are never deleted."*
   * 以及下面那句*"权威侧的 `deleteEventsAsync` 已经写穿，下一次加载就不会再读到它们"*。
   * 实测结论：
   *
   * 1. **真正在删除会话时清掉事件的是数据库的外键级联**，不是这里 ——
   *    真机（临时库）实测：`sessions.delete { id, confirm_bulk: true }`
   *    → `{"affected_rows": 71, "written": 1}`（1 个会话 + 70 条事件），删完 `session_events = 0`；
   * 2. 本函数**当前没有任何生产调用点**（全仓 grep 只有定义与注释）——
   *    所以"这是删除会话时的唯一清理路径"这句是**假的**；
   * 3. "已经写穿"也**不成立**：引擎侧那条命令带批量删除闸门，
   *    事件数 > 50 时不带 `confirm_bulk` 会被**拒绝**（第 55 轮实测，见 `rust-port.ts` 里的引文），
   *    而这里先把内存镜像清空了 —— 于是进程内"读不到事件"、库里一条没少，
   *    重启后又读回来。**只有真写穿时**"下次加载读不到"这句话才成立。
   *
   * 保留这个函数（不删）的理由：它是"想清空某会话事件但**不删会话行**"时唯一可用的入口，
   * 而且现在已经能真的写穿（`confirm_bulk`）。**没有生产调用点**这件事写在注释里，
   * 免得下一个人以为事件清理靠它。
   */
  deleteAllForSession(sessionId: string): void {
    /**
     * 端口优先，且**不要求镜像已加载**（第 12 轮）：删除是幂等的写穿操作，
     * 而未加载时走旧库在 rust 模式下只会抛错。镜像侧若正在加载，
     * `replaceSession([])` 之后加载完成会把行读回来 —— 那没关系：
     * 权威侧的 `deleteEventsAsync` 已经写穿，下一次加载就不会再读到它们。
     */
    const routed = rustEventPort(sessionId) ?? rustEventPortAny();
    if (routed) {
      // 镜像先清（读立刻一致），再排队落库
      routed.events.replaceSession(sessionId, []);
      routed.deleteEventsAsync(sessionId);
      return;
    }
    /**
     * **端口彻底没接手 → 如实上报"会话事件未删除"。**
     *
     * ⚠️ 这里**不能静默 return**：静默返回会让调用方以为"事件已经清掉了"（B 类假成功）。
     * （第 55 轮更正：这里原来写的是"`deleteAllForSession` 是删除会话时的唯一事件清理路径"——
     *  不实，见函数头：删除会话时真正的清理者是外键级联，且本函数当前没有生产调用点。
     *  但"不许静默"这条要求与调用点在哪无关，所以保留。）
     * 旧库的 `DELETE FROM session_events` + `persistDatabase()` 已在 L4 收尾时删除。
     */
    reportPersistFailure(
      "eventLog.deleteAllForSession",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "会话事件未删除",
    );
  }

  /**
   * Fork: copy events from one session to another.
   * Used for session forking — the new session starts with a copy of the source session's events.
   */
  forkSession(sourceSessionId: string, targetSessionId: string): number {
    const events = this.readAll(sourceSessionId);
    if (events.length === 0) {
      /**
       * 源会话读不到任何事件：**两种原因必须分开**。
       *
       * - 源会话本来就是空的（正常）→ 什么都不上报（否则每 fork 一次空会话就误报一次失败）；
       * - **端口根本没接手**（未注册 / 不是 rust）→ 这是 A 态，即本批删掉的那条路：
       *   `readAll` 已不再回退旧库，所以"读不到"就是"这次 fork 拿不到数据"，
       *   如实上报（**不允许**静默返回 0 让调用方以为"源会话是空的"）。
       *
       * 中间态（端口在 rust、但源会话镜像还没加载完）**保持原样**：`readAll` 会顺带
       * 触发惰性加载，下一次调用即成；这里不额外上报，避免"仓库里有数据却报失败"的误报
       * （那是 B 态语义，不属于本批要删的 A 态）。
       */
      if (!hasStoragePort()) {
        reportPersistFailure(
          "eventLog.forkSession",
          new Error("端口未接手（该域镜像未注册或未就绪）"),
          "会话事件未复制（fork 未生效：源会话事件读不到）",
        );
      }
      return 0;
    }

    // 两端都已加载完才走镜像（fork 会同时写源与目标两侧的镜像状态）
    const srcOk = rustEventPort(sourceSessionId) !== null;
    const dstPort = rustEventPort(targetSessionId);
    if (srcOk && dstPort) {
      const timestamp = Date.now();
      const prepared = events.map((evt) => {
        const payloadStr = JSON.stringify(evt.payload);
        const placeholder = dstPort.events.appendLocal(targetSessionId, String(evt.type), payloadStr, timestamp);
        return { type: String(evt.type), payload: payloadStr, timestamp, placeholderSeq: placeholder.seq };
      });
      dstPort.appendEventBatchAsync(targetSessionId, prepared);
      return prepared.length;
    }

    /**
     * **端口没接手（源或目标任一侧不可用）→ 如实上报，返回 0。**
     *
     * 返回 `0` 与原来门控那句 `if (!shouldFallbackToLegacy()) return 0;` 语义一致，
     * 但**多了一次失败上报**：`0` 既可以读成"源会话本来就没有事件"，
     * 也可以读成"这次没拷贝成功"，只有上报能把后者说出来（不然就是 B 类假成功）。
     *
     * 旧库的 `BEGIN/INSERT/COMMIT` + `persistDatabase()` 已在 L4 收尾时删除
     * （写进旧库而读走镜像 = 本进程内读写分裂，且 rust 模式下旧库刻意不存在）。
     */
    reportPersistFailure(
      "eventLog.forkSession",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "会话事件未复制（fork 未生效）",
    );
    return 0;
  }
}

// ========== Singleton Access ==========

export function getEventLog(): EventLog {
  return EventLog.getInstance();
}

// ========== 第 61 轮：把「读不到」与「没有事件」分开（消费方共用的两个判据）==========
//
// ## 为什么需要它们（第 60/61 轮的真机取证）
//
// `EventLog.readAll(sid)` 有一条硬路由规则：**该会话的事件镜像没加载完 → 返回空数组**。
// 于是"读不到"与"确实没有事件"在返回值上**完全同形**，而读事件的生产消费方此前
// 一律把空数组当成事实：
//
// - 维护里的不变量审计：把空当成"没有缺口" ⇒ 反过来把**每条消息**都报成缺口
//   （真机实测：同一份数据两次维护报 **934** 与 **749**，934 恰好等于会话的消息行总数）；
// - `session_event_search`（**模型可见**的工具）：把空当成"没有匹配" ⇒
//   对模型说"这个会话里没有匹配的事件"；
// - `generatePostmortem`（错误路径上生成的**落盘报告**）：把空当成
//   "session may not have started properly"，并把 `totalEvents` 写成 0；
// - `uiTrajectory.getSessionTrajectory`：把空当成"没有轨迹" ⇒ 面板空着。
//
// 两个判据就是这条区分的最小公共面：一个**同步问**、一个**异步等**。
// 消费方按自己的能力选（同步读的 UI 用前者；async 的工具/报告用后者）。

/**
 * 该会话的事件**此刻读得到吗**。
 *
 * - `true`：镜像已就绪 → `readAll` 返回的就是真值（空 = 确实没有事件）；
 * - `false`：**不知道**（镜像没加载完 / 正在加载 / 加载失败）→ `readAll` 的空数组
 *   不代表"没有事件"，调用方**不许**据此下结论。
 *
 * 端口连事件通道都没有（未注册）时返回 `true`：那种状态下两条读路径同样为空，
 * 在这里报"读不到"只会变成噪声（与维护里 `waitForSessionMirrors` 同一条判据）。
 */
export function isSessionEventsReadable(sessionId: string): boolean {
  const port = hasStoragePort()
    ? (getStoragePort() as unknown as { events?: { isLoaded?: (s: string) => boolean } })
    : null;
  const events = port?.events;
  if (!events || typeof events.isLoaded !== "function") return true;
  try {
    return events.isLoaded(sessionId) === true;
  } catch {
    return false;
  }
}

/**
 * 等该会话的事件镜像就绪（**异步读路径专用**）。
 *
 * 返回 `true` = 等到了（或本来就读得到）；`false` = 超时/加载失败 ⇒ **仍然读不到**，
 * 调用方必须如实说明"读不到"，不许把它渲染成"没有数据"。
 *
 * 等待是**触发**加载（`ensureLoaded` 本来就该被读路径触发），不是新增加载；
 * 上限 `timeoutMs` 保证调用方不会被拖死。
 */
export function whenSessionEventsLoaded(sessionId: string, timeoutMs = 4000): Promise<boolean> {
  const port = hasStoragePort()
    ? (getStoragePort() as unknown as {
        events?: { isLoaded?: (s: string) => boolean; ensureLoaded?: (s: string, cb?: () => void) => void };
      })
    : null;
  const events = port?.events;
  if (!events?.ensureLoaded || typeof events.isLoaded !== "function") return Promise.resolve(true);
  if (events.isLoaded(sessionId) === true) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      let ok = false;
      try {
        ok = events.isLoaded!(sessionId) === true;
      } catch {
        ok = false;
      }
      resolve(ok);
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    try {
      events.ensureLoaded!(sessionId, () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

// R3-3.8 的「可替换持久化提供者」在 P5 第 2 段被删除。
//
// 原实现（configurePersistenceProvider / getActivePersistenceProvider +
// storage/persistence-provider.ts 里的 SqlitePersistenceProvider）只把传入的对象
// **存进一个变量**，注释里写着"currently EventLog uses SQLite directly" ——
// 也就是说它从来没有真的接管过任何读写，却是一份完整的、直接操作旧库的 session_events
// 实现（238 行），是"删除 WASM 依赖"清单上的假障碍。
// 证据：全仓只有类型引用（`import("./persistence-provider").PersistenceProvider`），
// 零个值调用点 —— 连编译器都在报它。

// ========== Migration: Import existing messages as events ==========

/**
 * Migrate existing messages from the old CRUD format to event log format.
 * This is called once during database initialization to backfill the event log.
 * Only processes messages that don't already have corresponding events.
 */
export async function migrateMessagesToEvents(sessionId: string): Promise<number> {
  const eventLog = getEventLog();
  const existingCount = eventLog.count(sessionId);

  // If events already exist for this session, skip migration
  if (existingCount > 0) {
    return 0;
  }

  // Import old messages
  const { listMessages } = await import("./message");
  const messages = listMessages(sessionId);
  if (messages.length === 0) return 0;

  const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      events.push({
        type: "user_message",
        payload: {
          messageId: msg.id,
          content: msg.content,
        },
      });
    } else if (msg.role === "assistant") {
      if (msg.content) {
        events.push({
          type: "assistant_text",
          payload: {
            messageId: msg.id,
            content: msg.content,
            model: msg.model,
          },
        });
      }
      if (msg.reasoning) {
        events.push({
          type: "assistant_reasoning",
          payload: {
            messageId: msg.id,
            content: msg.reasoning,
          },
        });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          events.push({
            type: "tool_call",
            payload: {
              toolCallId: tc.id,
              messageId: msg.id,
              tool: tc.tool,
              args: tc.args,
              status: "completed",
            },
          });
          if (tc.result) {
            events.push({
              type: "tool_result",
              payload: {
                toolCallId: tc.id,
                messageId: msg.id,
                result: tc.result,
                status: "completed",
              },
            });
          }
        }
      }
    }
  }

  if (events.length === 0) return 0;

  eventLog.appendBatch(sessionId, events);
  console.log(`[EventLog] Migrated ${events.length} events for session ${sessionId}`);
  return events.length;
}
