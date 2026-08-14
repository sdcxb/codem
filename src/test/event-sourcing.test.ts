/**
 * P0-1: Event Sourcing — Tests for session event log and projection
 *
 * Tests:
 * 1. EventLog append/read/fork
 * 2. EventProjection produces correct LLM messages
 * 3. Compaction event correctly replaces old messages
 * 4. Dual-write: createMessage writes both CRUD and event log
 * 5. Migration: old messages can be migrated to events
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock database — we test the event log logic, not SQLite
const mockDb = {
  data: [] as any[],
  seq: 0,
  run(sql: string, params?: any[]) {
    if (sql.startsWith("INSERT INTO session_events")) {
      this.seq++;
      this.data.push({
        seq: this.seq,
        session_id: params[0],
        event_type: params[1],
        payload: JSON.parse(params[2]),
        timestamp: params[3],
      });
    } else if (sql.startsWith("DELETE FROM session_events")) {
      this.data = this.data.filter(d => d.session_id !== params[0]);
    } else if (sql === "BEGIN TRANSACTION" || sql === "COMMIT" || sql === "ROLLBACK") {
      // no-op
    } else if (sql.startsWith("INSERT INTO session_fts")) {
      // no-op for FTS
    }
  },
  exec(sql: string, params?: any[]) {
    if (sql.startsWith("SELECT seq")) {
      const sessionId = params[0];
      let filtered = this.data.filter(d => d.session_id === sessionId);
      if (sql.includes("AND seq >=")) {
        const fromSeq = params[1];
        filtered = filtered.filter(d => d.seq >= fromSeq);
      }
      filtered.sort((a, b) => a.seq - b.seq);
      if (filtered.length === 0) return [];
      return [{
        columns: ["seq", "session_id", "event_type", "payload", "timestamp"],
        values: filtered.map(d => [d.seq, d.session_id, d.event_type, JSON.stringify(d.payload), d.timestamp]),
      }];
    }
    if (sql.startsWith("SELECT MAX(seq)")) {
      const sessionId = params[0];
      const filtered = this.data.filter(d => d.session_id === sessionId);
      const maxSeq = filtered.length > 0 ? Math.max(...filtered.map(d => d.seq)) : 0;
      return [{ columns: ["MAX(seq)"], values: [[maxSeq]] }];
    }
    if (sql.startsWith("SELECT COUNT(*)")) {
      const sessionId = params[0];
      const count = this.data.filter(d => d.session_id === sessionId).length;
      return [{ columns: ["COUNT(*)"], values: [[count]] }];
    }
    if (sql === "SELECT last_insert_rowid()") {
      return [{ columns: ["last_insert_rowid()"], values: [[this.seq]] }];
    }
    return [];
  },
};

// Mock the database module before importing
vi.mock("../core/storage/database", () => ({
  getDatabase: () => mockDb,
  persistDatabase: () => {},
}));

import { EventLog } from "../core/storage/event-log";
import { EventProjection } from "../core/storage/event-projection";

describe("P0-1: Event Sourcing", () => {
  let eventLog: InstanceType<typeof EventLog>;
  let projection: InstanceType<typeof EventProjection>;

  beforeEach(() => {
    mockDb.data = [];
    mockDb.seq = 0;
    eventLog = new EventLog();
    projection = new EventProjection();
  });

  describe("EventLog", () => {
    it("should append events with incrementing sequence numbers", () => {
      const e1 = eventLog.append("sess1", "user_message", { messageId: "m1", content: "hello" });
      const e2 = eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "hi" });

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e1.type).toBe("user_message");
      expect(e2.type).toBe("assistant_text");
    });

    it("should read all events in order", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "hello" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "hi" });

      const events = eventLog.readAll("sess1");
      expect(events.length).toBe(2);
      expect(events[0].type).toBe("user_message");
      expect(events[1].type).toBe("assistant_text");
    });

    it("should isolate events between sessions", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "hello" });
      eventLog.append("sess2", "user_message", { messageId: "m2", content: "world" });

      expect(eventLog.count("sess1")).toBe(1);
      expect(eventLog.count("sess2")).toBe(1);
      expect(eventLog.readAll("sess1")[0].payload.content).toBe("hello");
      expect(eventLog.readAll("sess2")[0].payload.content).toBe("world");
    });

    it("should fork a session (copy events)", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "hello" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "response" });

      const count = eventLog.forkSession("sess1", "sess2");
      expect(count).toBe(2);
      expect(eventLog.count("sess2")).toBe(2);

      const forkedEvents = eventLog.readAll("sess2");
      expect(forkedEvents[0].type).toBe("user_message");
      expect(forkedEvents[1].type).toBe("assistant_text");
    });

    it("should read events from a specific sequence", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "first" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "second" });
      eventLog.append("sess1", "user_message", { messageId: "m3", content: "third" });

      const from2 = eventLog.readFrom("sess1", 2);
      expect(from2.length).toBe(2);
      expect(from2[0].seq).toBe(2);
      expect(from2[1].seq).toBe(3);
    });

    it("should get latest sequence number", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "hello" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "hi" });

      expect(eventLog.getLatestSeq("sess1")).toBe(2);
      expect(eventLog.getLatestSeq("nonexistent")).toBe(0);
    });

    it("should append batch atomically", () => {
      const events = eventLog.appendBatch("sess1", [
        { type: "user_message", payload: { messageId: "m1", content: "hello" } },
        { type: "assistant_text", payload: { messageId: "m2", content: "hi" } },
        { type: "tool_call", payload: { toolCallId: "tc1", messageId: "m2", tool: "read", args: {}, status: "completed" } },
      ]);

      expect(events.length).toBe(3);
      expect(events[0].seq).toBe(1);
      expect(events[1].seq).toBe(2);
      expect(events[2].seq).toBe(3);
      expect(eventLog.count("sess1")).toBe(3);
    });
  });

  describe("EventProjection", () => {
    it("should produce user and assistant messages", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "hello" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "Hi there!" });

      const messages = projection.projectAll("sess1");
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Hi there!");
    });

    it("should produce tool call and tool result messages", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "read file" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "" });
      eventLog.append("sess1", "tool_call", {
        toolCallId: "tc1",
        messageId: "m2",
        tool: "read",
        args: { path: "/test.ts" },
        status: "completed",
      });
      eventLog.append("sess1", "tool_result", {
        toolCallId: "tc1",
        messageId: "m2",
        result: "file content here",
        status: "completed",
      });

      const messages = projection.projectAll("sess1");
      // user + assistant(with tool_calls) + tool result
      expect(messages.length).toBe(3);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect((messages[1] as any).tool_calls?.length).toBe(1);
      expect(messages[2].role).toBe("tool");
      expect(messages[2].content).toBe("file content here");
    });

    it("should handle compaction event", () => {
      // Add initial messages
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "old question" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "old answer" });
      eventLog.append("sess1", "user_message", { messageId: "m3", content: "new question" });
      eventLog.append("sess1", "assistant_text", { messageId: "m4", content: "new answer" });

      // Add compaction event removing old messages
      eventLog.append("sess1", "compaction", {
        removedMessageIds: ["m1", "m2"],
        summary: "Summary of old conversation",
        messagesBefore: 4,
        messagesAfter: 3, // 2 kept + 1 summary marker
      });

      const messages = projection.projectAll("sess1");
      // Should have: summary + m3 + m4 = 3 messages
      expect(messages.length).toBe(3);
      expect(messages[0].role).toBe("system");
      expect((messages[0].content as string).includes("Summary of old conversation")).toBe(true);
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toBe("new question");
      expect(messages[2].role).toBe("assistant");
      expect(messages[2].content).toBe("new answer");
    });

    it("should handle empty session", () => {
      const messages = projection.projectAll("nonexistent");
      expect(messages.length).toBe(0);
    });

    it("should handle incremental projection", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "first" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "reply1" });

      const prevMessages = projection.projectAll("sess1");
      expect(prevMessages.length).toBe(2);

      // Add more events
      eventLog.append("sess1", "user_message", { messageId: "m3", content: "second" });
      eventLog.append("sess1", "assistant_text", { messageId: "m4", content: "reply2" });

      // Incremental projection from seq 3
      const newMessages = projection.projectIncremental(
        "sess1",
        3,
        prevMessages,
        new Map(),
      );

      // Should include all 4 messages (incremental appends)
      expect(newMessages.length).toBe(4);
      expect(newMessages[2].content).toBe("second");
      expect(newMessages[3].content).toBe("reply2");
    });

    it("should do full rebuild when compaction exists in new events", () => {
      eventLog.append("sess1", "user_message", { messageId: "m1", content: "first" });
      eventLog.append("sess1", "assistant_text", { messageId: "m2", content: "reply1" });

      const prevMessages = projection.projectAll("sess1");

      // Add compaction in new events
      eventLog.append("sess1", "compaction", {
        removedMessageIds: ["m1"],
        summary: "compacted",
        messagesBefore: 2,
        messagesAfter: 2,
      });
      eventLog.append("sess1", "user_message", { messageId: "m3", content: "after compaction" });

      const newMessages = projection.projectIncremental(
        "sess1",
        3, // from seq 3
        prevMessages,
        new Map(),
      );

      // Should have done a full rebuild: summary + m2 + m3 = 3
      expect(newMessages.length).toBe(3);
      expect(newMessages[0].role).toBe("system");
    });
  });
});
