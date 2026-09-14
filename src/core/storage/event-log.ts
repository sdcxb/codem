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

    // R3-4.6: Emit to TypedEventBus for strict event listeners
    // Dynamic import to avoid circular dependency
    import("../llm/event-system-strict")
      .then(({ getTypedEventBus }) => {
        getTypedEventBus().emit(event).catch(() => {});
      })
      .catch(() => {
        // Non-critical — event bus is optional
      });

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
