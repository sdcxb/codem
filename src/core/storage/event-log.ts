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
   * Read all events for a session, ordered by sequence number.
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
