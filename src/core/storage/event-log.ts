/**
 * Event Log — Append-only event storage
 *
 * Design (对标 DeepSeek Harness event-sourcing):
 * - Events are appended to SQLite session_events table
 * - Never deleted or updated (immutable log)
 * - Source of truth for session state
 * - Projection functions derive messages from events
 *
 * Dual-write transition:
 * - Phase 1: Both old CRUD (message.ts) and event log are written
 * - Phase 2: buildMessages() reads from event projection
 * - Phase 3: Old CRUD removed
 */

import { getDatabase, persistDatabase } from "./database";
import { getStoragePort, hasStoragePort } from "./port";

// ========== 迁移期：事件镜像分流（P3 第 4 段） ==========
//
// 端口是 rust 且事件镜像**已预热**时，读写都走镜像：
// - 读：同步（镜像整份在内存里，事件本来就要整份读来回放）；
// - 写：同步返回 + 发件箱异步落库（接口是同步的，而 IPC 是异步的，只能这样解）。
//
// 镜像未预热（尚未启动完 / 预热失败）时**完全走原路径** —— 功能不中断。
// 这正是回滚开关能生效的前提。

/**
 * "加载窗口期"内写进旧库、但需要补进镜像与 Rust 库的事件。
 *
 * ## 为什么需要它
 *
 * 某会话的事件加载是后台进行的（几百毫秒）。在那个窗口里 `isLoaded` 还是 false，
 * 所以 append 走的是**旧库**。等加载完成、切到镜像后，那几条事件就只在旧库里了 ——
 * 表现为"刚发的消息在事件日志里消失"。契约测试 EV-5 正是抓这个。
 *
 * 解法：窗口期内的 append 记在这里，加载完成后补写进 Rust 库（发件箱）
 * 并放进镜像，于是**两处最终一致**，一条都不丢。
 */
const pendingDuringLoad = new Map<string, Array<{ type: string; payload: string; timestamp: number; seq: number }>>();

function notePendingDuringLoad(sessionId: string, type: string, payload: string, timestamp: number, seq: number): void {
  const list = pendingDuringLoad.get(sessionId) ?? [];
  list.push({ type, payload, timestamp, seq });
  pendingDuringLoad.set(sessionId, list);
}

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
  const port = getStoragePort();
  if (port.kind !== "rust") return null;
  const candidate = port as unknown as RustEventPortLike;
  if (!candidate.events?.ensureLoaded) return null;
  if (sessionId === undefined) return candidate;
  // 加载中或未加载 → 注册补写回调，并在加载完成后把窗口期事件补进 Rust 库与镜像
  candidate.events.ensureLoaded(sessionId, () => {
    const buffered = pendingDuringLoad.get(sessionId);
    if (!buffered || buffered.length === 0) return;
    pendingDuringLoad.delete(sessionId);
    for (const b of buffered) {
      const local = candidate.events.appendLocal(sessionId, b.type, b.payload, b.timestamp);
      candidate.appendEventAsync(sessionId, b.type, b.payload, b.timestamp, local.seq);
    }
  });
  return candidate.events.isLoaded(sessionId) ? candidate : null;
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
    // 路由到镜像的**唯一条件**：该会话的事件已完整加载（见 rustEventPort 注释）。
    // 未加载完 → 继续走下面的旧路径，保证"读到的与写到的在同一处"。
    const routed = rustEventPort(sessionId);
    if (routed) return this.appendViaMirror(routed, sessionId, type, payload);

    const db = getDatabase();
    const timestamp = Date.now();
    const payloadStr = JSON.stringify(payload);

    db.run(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)",
      [sessionId, type, payloadStr, timestamp],
    );

    // Get the assigned sequence number
    const result = db.exec("SELECT last_insert_rowid()");
    const seq = result.length > 0 ? (result[0].values[0][0] as number) : 0;

    persistDatabase();

    const event: SessionEvent = {
      seq,
      sessionId,
      type,
      payload,
      timestamp,
    };

    // 若该会话正在加载事件镜像：记下这条，加载完成后补进 Rust 库与镜像（契约测试 EV-5）
    if (hasStoragePort() && getStoragePort().kind === "rust") {
      notePendingDuringLoad(sessionId, String(type), payloadStr, timestamp, seq);
    }

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
    // 与 append 同样的分流：该会话已加载完 → 走镜像 + 批量发件箱（单事务、seq 连续）
    const routed = rustEventPort(sessionId);
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

    const db = getDatabase();
    const timestamp = Date.now();
    const result: SessionEvent[] = [];

    // Use a transaction for atomicity
    db.run("BEGIN TRANSACTION");
    try {
      for (const evt of events) {
        const payloadStr = JSON.stringify(evt.payload);
        db.run(
          "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)",
          [sessionId, evt.type, payloadStr, timestamp],
        );
        const seqResult = db.exec("SELECT last_insert_rowid()");
        const seq = seqResult.length > 0 ? (seqResult[0].values[0][0] as number) : 0;
        result.push({
          seq,
          sessionId,
          type: evt.type,
          payload: evt.payload,
          timestamp,
        });
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }

    persistDatabase();
    return result;
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
   * @param projectUpTo 用"截至锚点的事件"计算快照载荷（保持 storage 层不反向依赖 projection）
   * @returns 删除的事件数与快照 seq
   */
  compactWithSnapshot(
    sessionId: string,
    projectUpTo: (events: SessionEvent[]) => Record<string, unknown>,
    opts: { keepEvents?: number } = {},
  ): { removedEvents: number; snapshotSeq: number } {
    const db = getDatabase();
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

    // 占位：用锚点的 seq 写入快照（替换掉那条事件，保持回放的顺序语义）
    db.run(
      "INSERT OR REPLACE INTO session_events (seq, session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?, ?)",
      [anchor.seq, sessionId, "session_snapshot", payloadStr, Date.now()],
    );
    db.run("DELETE FROM session_events WHERE session_id = ? AND seq < ? AND event_type <> 'session_meta'", [
      sessionId,
      anchor.seq,
    ]);
    const removedEvents = Number(db.exec("SELECT changes()")?.[0]?.values?.[0]?.[0] ?? 0);
    persistDatabase();

    return { removedEvents, snapshotSeq: anchor.seq };
  }

  /**
   * 读所有事件（含快照）。顺序保证：快照一定排在其覆盖的事件之后（seq 单调）。
   */
  readAll(sessionId: string): SessionEvent[] {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.readAll(sessionId).map(toSessionEvent);
    const db = getDatabase();
    const result = db.exec(
      "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ? ORDER BY seq ASC",
      [sessionId],
    );

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      seq: row[0] as number,
      sessionId: row[1] as string,
      type: row[2] as SessionEventType,
      payload: JSON.parse(row[3] as string),
      timestamp: row[4] as number,
    }));
  }

  /**
   * Read events from a specific sequence number onward.
   * Used for incremental projections.
   */
  readFrom(sessionId: string, fromSeq: number): SessionEvent[] {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.readFrom(sessionId, fromSeq).map(toSessionEvent);
    const db = getDatabase();
    const result = db.exec(
      "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ? AND seq >= ? ORDER BY seq ASC",
      [sessionId, fromSeq],
    );

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      seq: row[0] as number,
      sessionId: row[1] as string,
      type: row[2] as SessionEventType,
      payload: JSON.parse(row[3] as string),
      timestamp: row[4] as number,
    }));
  }

  /**
   * Read events in a range (for pagination).
   */
  readRange(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[] {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.readRange(sessionId, fromSeq, toSeq).map(toSessionEvent);
    const db = getDatabase();
    const result = db.exec(
      "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC",
      [sessionId, fromSeq, toSeq],
    );

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      seq: row[0] as number,
      sessionId: row[1] as string,
      type: row[2] as SessionEventType,
      payload: JSON.parse(row[3] as string),
      timestamp: row[4] as number,
    }));
  }

  /**
   * Get the latest sequence number for a session.
   * Returns 0 if no events exist.
   */
  getLatestSeq(sessionId: string): number {
    const mirror = rustEventPort(sessionId)?.events ?? null;
    if (mirror) return mirror.latestSeq(sessionId);
    const db = getDatabase();
    const result = db.exec(
      "SELECT MAX(seq) FROM session_events WHERE session_id = ?",
      [sessionId],
    );

    if (result.length === 0 || !result[0].values[0][0]) return 0;
    return result[0].values[0][0] as number;
  }

  /**
   * Count events for a session.
   */
  count(sessionId: string): number {
    const routed = rustEventPort(sessionId);
    if (routed && routed.events.isLoaded(sessionId)) return routed.events.count(sessionId);
    const db = getDatabase();
    const result = db.exec(
      "SELECT COUNT(*) FROM session_events WHERE session_id = ?",
      [sessionId],
    );

    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  }

  /**
   * Delete all events for a session (used when session is deleted).
   * This is the ONLY deletion path — individual events are never deleted.
   */
  deleteAllForSession(sessionId: string): void {
    const routed = rustEventPort(sessionId);
    if (routed) {
      // 镜像先清（读立刻一致），再排队落库
      routed.events.replaceSession(sessionId, []);
      routed.deleteEventsAsync(sessionId);
      return;
    }
    const db = getDatabase();
    db.run("DELETE FROM session_events WHERE session_id = ?", [sessionId]);
    persistDatabase();
  }

  /**
   * Fork: copy events from one session to another.
   * Used for session forking — the new session starts with a copy of the source session's events.
   */
  forkSession(sourceSessionId: string, targetSessionId: string): number {
    const events = this.readAll(sourceSessionId);
    if (events.length === 0) return 0;

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

    const db = getDatabase();
    const timestamp = Date.now();

    db.run("BEGIN TRANSACTION");
    try {
      for (const evt of events) {
        db.run(
          "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)",
          [targetSessionId, evt.type, JSON.stringify(evt.payload), timestamp],
        );
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }

    persistDatabase();
    return events.length;
  }
}

// ========== Singleton Access ==========

export function getEventLog(): EventLog {
  return EventLog.getInstance();
}

// R3-3.8: Configure custom persistence provider
// Allows swapping the storage backend from SQLite to other implementations
export function configurePersistenceProvider(provider: import("./persistence-provider").PersistenceProvider): void {
  // The persistence provider interface is available for future use.
  // Currently EventLog uses SQLite directly, but this allows future migration.
  // The provider is stored and can be queried via getActivePersistenceProvider()
  activePersistenceProvider = provider;
}

let activePersistenceProvider: import("./persistence-provider").PersistenceProvider | null = null;

export function getActivePersistenceProvider(): import("./persistence-provider").PersistenceProvider | null {
  return activePersistenceProvider;
}

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
