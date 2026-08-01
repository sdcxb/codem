/**
 * FileChangeStorage — Per-turn file change tracking persistence
 *
 * Stores git tree snapshots + binary diffs + artifact metadata.
 * Independent from v2_sessions.messages JSON — not affected by context compaction.
 */

import { getDatabase } from "./database";

export interface TurnFileChangeRecord {
  id: string;
  session_id: string;
  message_id: string;
  turn_index: number;
  before_tree: string | null;
  after_tree: string | null;
  patch: string | null;
  changed_files: string | null; // JSON [{path, status, before_hash, after_hash}]
  patch_sha256: string | null;
  current_brief: string | null;
  status: "completed" | "reverted" | "pending_review";
  created_at: number;
}

export interface ChangedFile {
  path: string;
  status: string; // M, A, D, R
  before_hash?: string;
  after_hash?: string;
}

function rowToRecord(row: any): TurnFileChangeRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    turn_index: row.turn_index,
    before_tree: row.before_tree,
    after_tree: row.after_tree,
    patch: row.patch,
    changed_files: row.changed_files,
    patch_sha256: row.patch_sha256,
    current_brief: row.current_brief,
    status: row.status || "completed",
    created_at: row.created_at,
  };
}

export const FileChangeStorage = {
  create(record: TurnFileChangeRecord): void {
    const db = getDatabase();
    if (!db) return;
    db.run(
      `INSERT INTO turn_file_changes
       (id, session_id, message_id, turn_index, before_tree, after_tree, patch, changed_files, patch_sha256, current_brief, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.session_id,
        record.message_id,
        record.turn_index,
        record.before_tree,
        record.after_tree,
        record.patch,
        record.changed_files,
        record.patch_sha256,
        record.current_brief,
        record.status,
        record.created_at,
      ],
    );
  },

  listBySession(sessionId: string): TurnFileChangeRecord[] {
    const db = getDatabase();
    if (!db) return [];
    const result = db.exec(
      `SELECT * FROM turn_file_changes WHERE session_id = ? ORDER BY turn_index DESC`,
      [sessionId],
    );
    if (!result.length || !result[0].values.length) return [];
    const columns = result[0].columns;
    return result[0].values.map((row) => {
      const obj: any = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return rowToRecord(obj);
    });
  },

  getById(id: string): TurnFileChangeRecord | null {
    const db = getDatabase();
    if (!db) return null;
    const result = db.exec(`SELECT * FROM turn_file_changes WHERE id = ?`, [id]);
    if (!result.length || !result[0].values.length) return null;
    const columns = result[0].columns;
    const row = result[0].values[0];
    const obj: any = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return rowToRecord(obj);
  },

  updateStatus(id: string, status: string): void {
    const db = getDatabase();
    if (!db) return;
    db.run(`UPDATE turn_file_changes SET status = ? WHERE id = ?`, [status, id]);
  },

  deleteBySession(sessionId: string): void {
    const db = getDatabase();
    if (!db) return;
    db.run(`DELETE FROM turn_file_changes WHERE session_id = ?`, [sessionId]);
  },

  parseChangedFiles(record: TurnFileChangeRecord): ChangedFile[] {
    if (!record.changed_files) return [];
    try {
      return JSON.parse(record.changed_files);
    } catch {
      return [];
    }
  },
};
