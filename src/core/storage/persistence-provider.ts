/**
 * Persistence Provider — 持久化多后端
 *
 * 设计对标 DSH `session-persistence-*` 多后端机制。
 *
 * R3-3.8: 将事件日志的存储从硬编码 SQLite 抽象为 Provider 接口，
 * 允许未来替换为其他后端（如 JSONL 文件、远程 API）。
 *
 * 三角色分离（与 DSH 一致）：
 * - PersistenceProvider（本文件）：存储接口定义
 * - SqlitePersistenceProvider：默认 SQLite 实现
 * - EventLog：调用 Provider 完成实际存储
 *
 * 这一步只做接口抽象，不改变现有 SQLite 实现的行为。
 */

// ========== Types ==========

/** 持久化事件记录 */
export interface PersistedEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: string; // JSON string
  timestamp: number;
}

/** 持久化查询选项 */
export interface QueryOptions {
  sessionId: string;
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
  orderBy?: "asc" | "desc";
}

// ========== Persistence Provider Interface ==========

/**
 * 持久化后端接口。
 *
 * 任何实现此接口的类都可以作为事件日志的存储后端。
 * 默认实现是 SQLite，未来可以是 JSONL、远程 API 等。
 */
export interface PersistenceProvider {
  /** 追加一个事件 */
  append(sessionId: string, type: string, payload: string, timestamp: number): number;
  /** 批量追加 */
  appendBatch(sessionId: string, events: Array<{ type: string; payload: string; timestamp: number }>): number[];
  /** 读取所有事件 */
  readAll(sessionId: string): PersistedEvent[];
  /** 读取从指定 seq 开始的事件 */
  readFrom(sessionId: string, fromSeq: number): PersistedEvent[];
  /** 读取指定范围的事件 */
  readRange(sessionId: string, fromSeq: number, toSeq: number): PersistedEvent[];
  /** 获取最新的 seq */
  getLatestSeq(sessionId: string): number;
  /** 计数 */
  count(sessionId: string): number;
  /** 删除会话的所有事件 */
  deleteAllForSession(sessionId: string): void;
  /** 复制会话事件到另一个会话（fork） */
  forkSession(sourceSessionId: string, targetSessionId: string): number;
}

// ========== SQLite Provider Implementation ==========

import { getDatabase, persistDatabase } from "./database";

/**
 * SQLite 持久化后端 — 默认实现。
 *
 * 包装现有 EventLog 的数据库操作，
 * 使其符合 PersistenceProvider 接口。
 */
export class SqlitePersistenceProvider implements PersistenceProvider {
  append(sessionId: string, type: string, payload: string, timestamp: number): number {
    const db = getDatabase();
    db.run(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)",
      [sessionId, type, payload, timestamp],
    );
    const result = db.exec("SELECT last_insert_rowid()");
    const seq = result.length > 0 ? (result[0].values[0][0] as number) : 0;
    persistDatabase();
    return seq;
  }

  appendBatch(
    sessionId: string,
    events: Array<{ type: string; payload: string; timestamp: number }>,
  ): number[] {
    const db = getDatabase();
    const seqs: number[] = [];

    db.run("BEGIN TRANSACTION");
    try {
      for (const evt of events) {
        db.run(
          "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)",
          [sessionId, evt.type, evt.payload, evt.timestamp],
        );
        const seqResult = db.exec("SELECT last_insert_rowid()");
        const seq = seqResult.length > 0 ? (seqResult[0].values[0][0] as number) : 0;
        seqs.push(seq);
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }

    persistDatabase();
    return seqs;
  }

  readAll(sessionId: string): PersistedEvent[] {
    const db = getDatabase();
    const result = db.exec(
      "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ? ORDER BY seq ASC",
      [sessionId],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      seq: row[0] as number,
      sessionId: row[1] as string,
      type: row[2] as string,
      payload: row[3] as string,
      timestamp: row[4] as number,
    }));
  }

  readFrom(sessionId: string, fromSeq: number): PersistedEvent[] {
    const db = getDatabase();
    const result = db.exec(
      "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ? AND seq >= ? ORDER BY seq ASC",
      [sessionId, fromSeq],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      seq: row[0] as number,
      sessionId: row[1] as string,
      type: row[2] as string,
      payload: row[3] as string,
      timestamp: row[4] as number,
    }));
  }

  readRange(sessionId: string, fromSeq: number, toSeq: number): PersistedEvent[] {
    const db = getDatabase();
    const result = db.exec(
      "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC",
      [sessionId, fromSeq, toSeq],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      seq: row[0] as number,
      sessionId: row[1] as string,
      type: row[2] as string,
      payload: row[3] as string,
      timestamp: row[4] as number,
    }));
  }

  getLatestSeq(sessionId: string): number {
    const db = getDatabase();
    const result = db.exec(
      "SELECT MAX(seq) FROM session_events WHERE session_id = ?",
      [sessionId],
    );
    if (result.length === 0 || !result[0].values[0][0]) return 0;
    return result[0].values[0][0] as number;
  }

  count(sessionId: string): number {
    const db = getDatabase();
    const result = db.exec(
      "SELECT COUNT(*) FROM session_events WHERE session_id = ?",
      [sessionId],
    );
    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  }

  deleteAllForSession(sessionId: string): void {
    const db = getDatabase();
    db.run("DELETE FROM session_events WHERE session_id = ?", [sessionId]);
    persistDatabase();
  }

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
          [targetSessionId, evt.type, evt.payload, timestamp],
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

// ========== Provider Registry ==========

let providerInstance: PersistenceProvider | null = null;

/**
 * 获取当前持久化后端。
 * 默认返回 SQLite 实现。
 */
export function getPersistenceProvider(): PersistenceProvider {
  if (!providerInstance) {
    providerInstance = new SqlitePersistenceProvider();
  }
  return providerInstance;
}

/**
 * 设置持久化后端 — 用于替换为其他实现。
 * 在应用启动时调用，在 EventLog 初始化之前。
 */
export function setPersistenceProvider(provider: PersistenceProvider): void {
  providerInstance = provider;
}
